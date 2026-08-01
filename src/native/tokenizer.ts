import type { NativeTokenizerAddedToken, NativeTokenizerSpec } from "./types.js";

const BYTE_LEVEL_REGEX = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export type NativeTokenizer = {
  readonly spec: NativeTokenizerSpec;
  encode(text: string, options?: { addBos?: boolean; addEos?: boolean }): number[];
  decode(tokens: number[], options?: { skipSpecialTokens?: boolean }): string;
};

export function createTokenizer(spec: NativeTokenizerSpec): NativeTokenizer {
  if (spec.kind === "byte") {
    return new ByteTokenizer(spec);
  }
  if (spec.kind === "hf-bpe") {
    return new HuggingFaceBpeTokenizer(spec);
  }
  if (spec.kind === "hf-unigram") {
    return new HuggingFaceUnigramTokenizer(spec);
  }
  return new CharacterTokenizer(spec);
}

export function createTokenizerFromHfTokenizerJson(params: {
  tokenizer: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
}): NativeTokenizer | null {
  const spec = createSpecFromHfTokenizerJson(params);
  return spec ? createTokenizer(spec) : null;
}

export function createSpecFromHfTokenizerJson(params: {
  tokenizer: Record<string, unknown>;
  tokenizerConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
  chatTemplate?: string;
}): NativeTokenizerSpec | null {
  const model = asRecord(params.tokenizer.model);
  if (!model || typeof model.type !== "string") {
    return null;
  }

  const addedTokens = normalizeAddedTokens(params.tokenizer.added_tokens);
  const preTokenizer = asRecord(params.tokenizer.pre_tokenizer);
  const decoder = asRecord(params.tokenizer.decoder);

  if (model.type === "BPE") {
    const vocab = asRecord(model.vocab);
    if (!vocab) {
      return null;
    }

    const tokenToId: Record<string, number> = {};
    for (const [token, id] of Object.entries(vocab)) {
      if (typeof id === "number") {
        tokenToId[token] = id;
      }
    }
    for (const token of addedTokens) {
      tokenToId[token.content] = token.id;
    }

    const specialTokens = resolveSpecialTokenIds({
      tokenToId,
      addedTokens,
      tokenizerConfig: params.tokenizerConfig,
      specialTokensMap: params.specialTokensMap,
    });
    const merges = normalizeMerges(model.merges);

    return {
      kind: "hf-bpe",
      tokenToId,
      merges,
      bosTokenId: specialTokens.bosTokenId,
      eosTokenId: specialTokens.eosTokenId,
      unkTokenId: specialTokens.unkTokenId,
      padTokenId: specialTokens.padTokenId,
      specialTokens: specialTokens.specialTokens,
      addedTokens,
      addPrefixSpace: preTokenizer?.type === "ByteLevel" ? preTokenizer.add_prefix_space === true : false,
      continuingSubwordPrefix: typeof model.continuing_subword_prefix === "string" ? model.continuing_subword_prefix : undefined,
      endOfWordSuffix: typeof model.end_of_word_suffix === "string" ? model.end_of_word_suffix : undefined,
      byteFallback: model.byte_fallback === true,
      unkToken: typeof model.unk_token === "string" ? model.unk_token : undefined,
      decoderCleanup: decoder?.type === "ByteLevel" ? decoder.cleanup !== false : true,
      chatTemplate: params.chatTemplate,
    };
  }

  if (model.type === "Unigram") {
    const normalized = normalizeUnigramVocab(model.vocab);
    if (!normalized) {
      return null;
    }
    const tokenToId: Record<string, number> = {};
    for (const [index, piece] of normalized.vocab.entries()) {
      tokenToId[piece] = index;
    }
    for (const token of addedTokens) {
      tokenToId[token.content] = token.id;
    }

    const specialTokens = resolveSpecialTokenIds({
      tokenToId,
      addedTokens,
      tokenizerConfig: params.tokenizerConfig,
      specialTokensMap: params.specialTokensMap,
    });
    const metaspace = resolveMetaspaceConfig(preTokenizer, decoder);

    return {
      kind: "hf-unigram",
      vocab: normalized.vocab,
      scores: normalized.scores,
      tokenToId,
      bosTokenId: specialTokens.bosTokenId,
      eosTokenId: specialTokens.eosTokenId,
      unkTokenId: specialTokens.unkTokenId ?? (typeof model.unk_id === "number" ? model.unk_id : undefined),
      padTokenId: specialTokens.padTokenId,
      specialTokens: specialTokens.specialTokens,
      addedTokens,
      byteFallback: model.byte_fallback === true,
      unkToken: typeof model.unk_token === "string" ? model.unk_token : undefined,
      metaspaceReplacement: metaspace.replacement,
      metaspacePrependScheme: metaspace.prependScheme,
      chatTemplate: params.chatTemplate,
    };
  }

  return null;
}

class ByteTokenizer implements NativeTokenizer {
  readonly spec: NativeTokenizerSpec;
  private byteOffset: number;

  constructor(spec: NativeTokenizerSpec) {
    this.spec = spec;
    this.byteOffset = highestAssignedId(spec) + 1;
  }

  encode(text: string, options?: { addBos?: boolean; addEos?: boolean }): number[] {
    const bytes = Buffer.from(text, "utf8");
    const result: number[] = [];
    if (options?.addBos && typeof this.spec.bosTokenId === "number") {
      result.push(this.spec.bosTokenId);
    }
    for (const value of bytes) {
      result.push(this.byteOffset + value);
    }
    if (options?.addEos && typeof this.spec.eosTokenId === "number") {
      result.push(this.spec.eosTokenId);
    }
    return result;
  }

  decode(tokens: number[], options?: { skipSpecialTokens?: boolean }): string {
    const bytes: number[] = [];
    for (const token of tokens) {
      if (token >= this.byteOffset && token < this.byteOffset + 256) {
        bytes.push(token - this.byteOffset);
        continue;
      }
      if (!options?.skipSpecialTokens) {
        const marker = specialTokenText(this.spec, token);
        if (marker) {
          bytes.push(...Buffer.from(marker, "utf8"));
        }
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
}

class CharacterTokenizer implements NativeTokenizer {
  readonly spec: NativeTokenizerSpec;
  private idByPiece: Map<string, number>;
  private pieceById: Map<number, string>;
  private candidatePieces: string[];

  constructor(spec: NativeTokenizerSpec) {
    this.spec = spec;
    this.idByPiece = new Map<string, number>();
    this.pieceById = new Map<number, string>();
    for (const token of spec.addedTokens ?? []) {
      this.idByPiece.set(token.content, token.id);
      this.pieceById.set(token.id, token.content);
    }
    for (const [token, id] of Object.entries(spec.specialTokens ?? {})) {
      this.idByPiece.set(token, id);
      this.pieceById.set(id, token);
    }
    for (const [index, piece] of (spec.vocab ?? []).entries()) {
      if (!this.idByPiece.has(piece)) {
        this.idByPiece.set(piece, index);
        this.pieceById.set(index, piece);
      }
    }
    this.candidatePieces = Array.from(this.idByPiece.keys())
      .filter((piece) => !piece.startsWith("<"))
      .sort((left, right) => right.length - left.length);
  }

  encode(text: string, options?: { addBos?: boolean; addEos?: boolean }): number[] {
    const result: number[] = [];
    if (options?.addBos && typeof this.spec.bosTokenId === "number") {
      result.push(this.spec.bosTokenId);
    }
    let cursor = 0;
    while (cursor < text.length) {
      const special = matchSpecialToken(text, cursor, this.spec);
      if (special) {
        result.push(special.id);
        cursor += special.content.length;
        continue;
      }
      const matched = this.matchPiece(text, cursor);
      if (matched) {
        result.push(matched.id);
        cursor += matched.piece.length;
        continue;
      }
      const unknown = typeof this.spec.unkTokenId === "number" ? this.spec.unkTokenId : this.spec.eosTokenId;
      if (typeof unknown === "number") {
        result.push(unknown);
      }
      cursor += 1;
    }
    if (options?.addEos && typeof this.spec.eosTokenId === "number") {
      result.push(this.spec.eosTokenId);
    }
    return result;
  }

  decode(tokens: number[], options?: { skipSpecialTokens?: boolean }): string {
    let text = "";
    for (const token of tokens) {
      const piece = this.pieceById.get(token);
      if (!piece) {
        continue;
      }
      if (isSpecialPiece(piece, this.spec) && options?.skipSpecialTokens !== false) {
        continue;
      }
      text += piece;
    }
    return text;
  }

  private matchPiece(text: string, cursor: number): { piece: string; id: number } | null {
    for (const piece of this.candidatePieces) {
      if (!text.startsWith(piece, cursor)) {
        continue;
      }
      const id = this.idByPiece.get(piece);
      if (typeof id === "number") {
        return { piece, id };
      }
    }
    return null;
  }
}

class HuggingFaceBpeTokenizer implements NativeTokenizer {
  readonly spec: NativeTokenizerSpec;
  private tokenToId: Map<string, number>;
  private idToToken: Map<number, string>;
  private mergeRanks: Map<string, number>;
  private bpeCache = new Map<string, string[]>();
  private specialByContent: Array<{ content: string; id: number }>;
  private byteEncoder: Map<number, string>;
  private byteDecoder: Map<string, number>;

  constructor(spec: NativeTokenizerSpec) {
    this.spec = spec;
    this.tokenToId = new Map<string, number>();
    this.idToToken = new Map<number, string>();

    for (const [token, id] of Object.entries(spec.tokenToId ?? {})) {
      this.tokenToId.set(token, id);
      this.idToToken.set(id, token);
    }
    for (const token of spec.addedTokens ?? []) {
      this.tokenToId.set(token.content, token.id);
      this.idToToken.set(token.id, token.content);
    }
    for (const [token, id] of Object.entries(spec.specialTokens ?? {})) {
      this.tokenToId.set(token, id);
      this.idToToken.set(id, token);
    }

    this.specialByContent = collectSpecialTokens(spec)
      .sort((left, right) => right.content.length - left.content.length);
    this.mergeRanks = new Map<string, number>();
    for (const [index, pair] of (spec.merges ?? []).entries()) {
      this.mergeRanks.set(pair, index);
    }
    const mapping = createByteLevelMapping();
    this.byteEncoder = mapping.byteEncoder;
    this.byteDecoder = mapping.byteDecoder;
  }

  encode(text: string, options?: { addBos?: boolean; addEos?: boolean }): number[] {
    const result: number[] = [];
    if (options?.addBos && typeof this.spec.bosTokenId === "number") {
      result.push(this.spec.bosTokenId);
    }

    let value = text;
    if (this.spec.addPrefixSpace && value && !value.startsWith(" ")) {
      value = ` ${value}`;
    }

    let cursor = 0;
    while (cursor < value.length) {
      const special = this.matchSpecialToken(value, cursor);
      if (special) {
        result.push(special.id);
        cursor += special.content.length;
        continue;
      }

      const nextSpecialIndex = this.findNextSpecialIndex(value, cursor);
      const segment = value.slice(cursor, nextSpecialIndex === -1 ? value.length : nextSpecialIndex);
      result.push(...this.encodeSegment(segment));
      cursor += segment.length;
    }

    if (options?.addEos && typeof this.spec.eosTokenId === "number") {
      result.push(this.spec.eosTokenId);
    }
    return result;
  }

  decode(tokens: number[], options?: { skipSpecialTokens?: boolean }): string {
    let output = "";
    let buffer = "";

    for (const token of tokens) {
      const piece = this.idToToken.get(token);
      if (!piece) {
        continue;
      }
      if (isSpecialPiece(piece, this.spec)) {
        if (buffer) {
          output += this.decodeByteLevelString(buffer);
          buffer = "";
        }
        if (options?.skipSpecialTokens === true) {
          continue;
        }
        output += piece;
        continue;
      }
      buffer += piece;
    }

    if (buffer) {
      output += this.decodeByteLevelString(buffer);
    }
    return this.spec.decoderCleanup === false ? output : cleanupByteLevelText(output);
  }

  private encodeSegment(segment: string): number[] {
    const result: number[] = [];
    if (!segment) {
      return result;
    }
    const pieces = segment.match(BYTE_LEVEL_REGEX) ?? [segment];
    for (const piece of pieces) {
      const encoded = this.encodeBytes(piece);
      const tokens = this.applyBpe(encoded);
      for (const token of tokens) {
        const id = this.tokenToId.get(token);
        if (typeof id === "number") {
          result.push(id);
          continue;
        }
        const unknown = this.resolveUnknownTokenId();
        if (typeof unknown === "number") {
          result.push(unknown);
        }
      }
    }
    return result;
  }

  private encodeBytes(value: string): string {
    const bytes = Buffer.from(value, "utf8");
    let encoded = "";
    for (const byte of bytes) {
      encoded += this.byteEncoder.get(byte) ?? String.fromCharCode(byte);
    }
    return encoded;
  }

  private decodeByteLevelString(value: string): string {
    const bytes: number[] = [];
    for (const char of Array.from(value)) {
      const byte = this.byteDecoder.get(char);
      if (typeof byte === "number") {
        bytes.push(byte);
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }

  private applyBpe(token: string): string[] {
    const cached = this.bpeCache.get(token);
    if (cached) {
      return cached;
    }
    let word = Array.from(token);
    while (word.length > 1) {
      let bestPair: { key: string; rank: number } | null = null;
      for (let index = 0; index < word.length - 1; index += 1) {
        const key = `${word[index]} ${word[index + 1]}`;
        const rank = this.mergeRanks.get(key);
        if (typeof rank !== "number") {
          continue;
        }
        if (!bestPair || rank < bestPair.rank) {
          bestPair = { key, rank };
        }
      }
      if (!bestPair) {
        break;
      }
      const [left, right] = bestPair.key.split(" ");
      const merged: string[] = [];
      for (let index = 0; index < word.length; index += 1) {
        if (index < word.length - 1 && word[index] === left && word[index + 1] === right) {
          merged.push(left + right);
          index += 1;
          continue;
        }
        merged.push(word[index]!);
      }
      word = merged;
    }
    this.bpeCache.set(token, word);
    return word;
  }

  private matchSpecialToken(text: string, cursor: number): { content: string; id: number } | null {
    for (const token of this.specialByContent) {
      if (text.startsWith(token.content, cursor)) {
        return token;
      }
    }
    return null;
  }

  private findNextSpecialIndex(text: string, cursor: number): number {
    let best = -1;
    for (const token of this.specialByContent) {
      const index = text.indexOf(token.content, cursor);
      if (index === -1) {
        continue;
      }
      if (best === -1 || index < best) {
        best = index;
      }
    }
    return best;
  }

  private resolveUnknownTokenId(): number | undefined {
    if (typeof this.spec.unkTokenId === "number") {
      return this.spec.unkTokenId;
    }
    if (this.spec.unkToken) {
      return this.tokenToId.get(this.spec.unkToken);
    }
    return this.spec.eosTokenId;
  }
}

class HuggingFaceUnigramTokenizer implements NativeTokenizer {
  readonly spec: NativeTokenizerSpec;
  private tokenToId: Map<string, number>;
  private idToToken: Map<number, string>;
  private scoresById: Map<number, number>;
  private candidatesByFirstChar: Map<string, Array<{ piece: string; id: number; score: number }>>;
  private specialByContent: Array<{ content: string; id: number }>;

  constructor(spec: NativeTokenizerSpec) {
    this.spec = spec;
    this.tokenToId = new Map<string, number>();
    this.idToToken = new Map<number, string>();
    this.scoresById = new Map<number, number>();
    this.candidatesByFirstChar = new Map();

    for (const [index, piece] of (spec.vocab ?? []).entries()) {
      this.tokenToId.set(piece, index);
      this.idToToken.set(index, piece);
      this.scoresById.set(index, spec.scores?.[index] ?? 0);
    }
    for (const token of spec.addedTokens ?? []) {
      this.tokenToId.set(token.content, token.id);
      this.idToToken.set(token.id, token.content);
      this.scoresById.set(token.id, 0);
    }
    for (const [token, id] of Object.entries(spec.specialTokens ?? {})) {
      this.tokenToId.set(token, id);
      this.idToToken.set(id, token);
      this.scoresById.set(id, 0);
    }

    this.specialByContent = collectSpecialTokens(spec)
      .sort((left, right) => right.content.length - left.content.length);

    for (const [index, piece] of (spec.vocab ?? []).entries()) {
      if (isSpecialPiece(piece, spec)) {
        continue;
      }
      const first = Array.from(piece)[0];
      if (!first) {
        continue;
      }
      const candidates = this.candidatesByFirstChar.get(first) ?? [];
      candidates.push({
        piece,
        id: index,
        score: spec.scores?.[index] ?? 0,
      });
      this.candidatesByFirstChar.set(first, candidates);
    }

    for (const candidates of this.candidatesByFirstChar.values()) {
      candidates.sort((left, right) => right.piece.length - left.piece.length);
    }
  }

  encode(text: string, options?: { addBos?: boolean; addEos?: boolean }): number[] {
    const result: number[] = [];
    if (options?.addBos && typeof this.spec.bosTokenId === "number") {
      result.push(this.spec.bosTokenId);
    }

    let cursor = 0;
    while (cursor < text.length) {
      const special = this.matchSpecialToken(text, cursor);
      if (special) {
        result.push(special.id);
        cursor += special.content.length;
        continue;
      }

      const nextSpecialIndex = this.findNextSpecialIndex(text, cursor);
      const segment = text.slice(cursor, nextSpecialIndex === -1 ? text.length : nextSpecialIndex);
      result.push(...this.encodeSegment(segment));
      cursor += segment.length;
    }

    if (options?.addEos && typeof this.spec.eosTokenId === "number") {
      result.push(this.spec.eosTokenId);
    }
    return result;
  }

  decode(tokens: number[], options?: { skipSpecialTokens?: boolean }): string {
    let output = "";
    for (const token of tokens) {
      const piece = this.idToToken.get(token);
      if (!piece) {
        continue;
      }
      if (isSpecialPiece(piece, this.spec)) {
        if (options?.skipSpecialTokens === true) {
          continue;
        }
        output += piece;
        continue;
      }
      output += piece;
    }
    return decodeMetaspace(output, this.spec);
  }

  private encodeSegment(segment: string): number[] {
    if (!segment) {
      return [];
    }

    const normalized = encodeMetaspace(segment, this.spec);
    const chars = Array.from(normalized);
    const length = chars.length;
    const bestScore = new Array<number>(length + 1).fill(Number.NEGATIVE_INFINITY);
    const bestToken = new Array<number>(length).fill(-1);
    const bestNext = new Array<number>(length).fill(-1);
    bestScore[length] = 0;

    for (let index = length - 1; index >= 0; index -= 1) {
      const candidates = this.candidatesByFirstChar.get(chars[index]!) ?? [];
      for (const candidate of candidates) {
        const pieceChars = Array.from(candidate.piece);
        if (pieceChars.length > length - index) {
          continue;
        }
        let matched = true;
        for (let offset = 0; offset < pieceChars.length; offset += 1) {
          if (chars[index + offset] !== pieceChars[offset]) {
            matched = false;
            break;
          }
        }
        if (!matched) {
          continue;
        }
        const score = candidate.score + bestScore[index + pieceChars.length]!;
        if (score > bestScore[index]!) {
          bestScore[index] = score;
          bestToken[index] = candidate.id;
          bestNext[index] = index + pieceChars.length;
        }
      }
      if (bestToken[index] === -1) {
        bestToken[index] = this.resolveUnknownTokenId();
        bestNext[index] = index + 1;
        bestScore[index] = bestScore[index + 1] ?? 0;
      }
    }

    const result: number[] = [];
    let cursor = 0;
    while (cursor < length) {
      const tokenId = bestToken[cursor];
      const next = bestNext[cursor];
      if (tokenId === -1 || next <= cursor) {
        break;
      }
      result.push(tokenId);
      cursor = next;
    }
    return result;
  }

  private matchSpecialToken(text: string, cursor: number): { content: string; id: number } | null {
    for (const token of this.specialByContent) {
      if (text.startsWith(token.content, cursor)) {
        return token;
      }
    }
    return null;
  }

  private findNextSpecialIndex(text: string, cursor: number): number {
    let best = -1;
    for (const token of this.specialByContent) {
      const index = text.indexOf(token.content, cursor);
      if (index === -1) {
        continue;
      }
      if (best === -1 || index < best) {
        best = index;
      }
    }
    return best;
  }

  private resolveUnknownTokenId(): number {
    if (typeof this.spec.unkTokenId === "number") {
      return this.spec.unkTokenId;
    }
    if (this.spec.unkToken) {
      const mapped = this.tokenToId.get(this.spec.unkToken);
      if (typeof mapped === "number") {
        return mapped;
      }
    }
    return this.spec.eosTokenId ?? 0;
  }
}

function normalizeAddedTokens(value: unknown): NativeTokenizerAddedToken[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      id: typeof item.id === "number" ? item.id : -1,
      content: typeof item.content === "string" ? item.content : "",
      special: item.special === true,
    }))
    .filter((item) => item.id >= 0 && item.content);
}

function normalizeMerges(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const merges: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      merges.push(item);
      continue;
    }
    if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string") {
      merges.push(`${item[0]} ${item[1]}`);
    }
  }
  return merges;
}

function normalizeUnigramVocab(value: unknown): { vocab: string[]; scores: number[] } | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const vocab: string[] = [];
  const scores: number[] = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === "string") {
      vocab.push(item[0]);
      scores.push(typeof item[1] === "number" ? item[1] : 0);
      continue;
    }
    const record = asRecord(item);
    if (record && typeof record.piece === "string") {
      vocab.push(record.piece);
      scores.push(typeof record.score === "number" ? record.score : 0);
    }
  }
  return vocab.length > 0 ? { vocab, scores } : null;
}

function resolveSpecialTokenIds(params: {
  tokenToId?: Record<string, number>;
  addedTokens: NativeTokenizerAddedToken[];
  tokenizerConfig?: Record<string, unknown>;
  specialTokensMap?: Record<string, unknown>;
}): {
  bosTokenId?: number;
  eosTokenId?: number;
  unkTokenId?: number;
  padTokenId?: number;
  specialTokens: Record<string, number>;
} {
  const byContent = new Map<string, number>();
  for (const [token, id] of Object.entries(params.tokenToId ?? {})) {
    if (typeof id === "number") {
      byContent.set(token, id);
    }
  }
  for (const token of params.addedTokens) {
    if (token.special) {
      byContent.set(token.content, token.id);
    }
  }

  const bos = readSpecialTokenContent(params.tokenizerConfig?.bos_token ?? params.specialTokensMap?.bos_token);
  const eos = readSpecialTokenContent(params.tokenizerConfig?.eos_token ?? params.specialTokensMap?.eos_token);
  const unk = readSpecialTokenContent(params.tokenizerConfig?.unk_token ?? params.specialTokensMap?.unk_token);
  const pad = readSpecialTokenContent(params.tokenizerConfig?.pad_token ?? params.specialTokensMap?.pad_token);

  const specialTokens: Record<string, number> = {};
  for (const token of params.addedTokens) {
    if (token.special) {
      specialTokens[token.content] = token.id;
    }
  }

  return {
    bosTokenId: bos ? byContent.get(bos) : undefined,
    eosTokenId: eos ? byContent.get(eos) : undefined,
    unkTokenId: unk ? byContent.get(unk) : undefined,
    padTokenId: pad ? byContent.get(pad) : undefined,
    specialTokens,
  };
}

function resolveMetaspaceConfig(
  preTokenizer?: Record<string, unknown>,
  decoder?: Record<string, unknown>,
): {
  replacement: string;
  prependScheme: "always" | "first" | "never";
} {
  const replacement = typeof preTokenizer?.replacement === "string"
    ? preTokenizer.replacement
    : typeof decoder?.replacement === "string"
      ? decoder.replacement
      : "▁";
  const prependScheme = preTokenizer?.type === "Metaspace" && typeof preTokenizer.prepend_scheme === "string"
    ? normalizePrependScheme(preTokenizer.prepend_scheme)
    : decoder?.type === "Metaspace" && typeof decoder.prepend_scheme === "string"
      ? normalizePrependScheme(decoder.prepend_scheme)
      : "always";
  return {
    replacement,
    prependScheme,
  };
}

function readSpecialTokenContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (record && typeof record.content === "string") {
    return record.content;
  }
  return undefined;
}

function collectSpecialTokens(spec: NativeTokenizerSpec): Array<{ content: string; id: number }> {
  const tokens = new Map<string, number>();
  for (const token of spec.addedTokens ?? []) {
    if (token.special) {
      tokens.set(token.content, token.id);
    }
  }
  for (const [content, id] of Object.entries(spec.specialTokens ?? {})) {
    tokens.set(content, id);
  }
  return Array.from(tokens.entries()).map(([content, id]) => ({ content, id }));
}

function createByteLevelMapping(): {
  byteEncoder: Map<number, string>;
  byteDecoder: Map<string, number>;
} {
  const bytes: number[] = [];
  for (let code = 33; code <= 126; code += 1) bytes.push(code);
  for (let code = 161; code <= 172; code += 1) bytes.push(code);
  for (let code = 174; code <= 255; code += 1) bytes.push(code);

  const chars = [...bytes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (bytes.includes(byte)) {
      continue;
    }
    bytes.push(byte);
    chars.push(256 + extra);
    extra += 1;
  }

  const byteEncoder = new Map<number, string>();
  const byteDecoder = new Map<string, number>();
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    const char = String.fromCharCode(chars[index]!);
    byteEncoder.set(byte, char);
    byteDecoder.set(char, byte);
  }
  return { byteEncoder, byteDecoder };
}

function encodeMetaspace(value: string, spec: NativeTokenizerSpec): string {
  const replacement = spec.metaspaceReplacement ?? "▁";
  const prependScheme = spec.metaspacePrependScheme ?? "always";
  let normalized = value.replace(/ /g, replacement);
  if (prependScheme === "always" && normalized && !normalized.startsWith(replacement)) {
    normalized = replacement + normalized;
  }
  return normalized;
}

function decodeMetaspace(value: string, spec: NativeTokenizerSpec): string {
  const replacement = spec.metaspaceReplacement ?? "▁";
  const prependScheme = spec.metaspacePrependScheme ?? "always";
  let output = value.split(replacement).join(" ");
  if ((prependScheme === "always" || prependScheme === "first") && output.startsWith(" ")) {
    output = output.slice(1);
  }
  return output;
}

function cleanupByteLevelText(value: string): string {
  return value.replace(/\s+([?.!,;:])/g, "$1");
}

function highestAssignedId(spec: NativeTokenizerSpec): number {
  const ids = Object.values(spec.specialTokens ?? {});
  for (const token of spec.addedTokens ?? []) {
    ids.push(token.id);
  }
  for (const value of [spec.bosTokenId, spec.eosTokenId, spec.unkTokenId, spec.padTokenId]) {
    if (typeof value === "number") {
      ids.push(value);
    }
  }
  return ids.length > 0 ? Math.max(...ids) : -1;
}

function specialTokenText(spec: NativeTokenizerSpec, id: number): string | undefined {
  for (const token of spec.addedTokens ?? []) {
    if (token.id === id) {
      return token.content;
    }
  }
  for (const [token, tokenId] of Object.entries(spec.specialTokens ?? {})) {
    if (tokenId === id) {
      return token;
    }
  }
  if (spec.bosTokenId === id) {
    return "<bos>";
  }
  if (spec.eosTokenId === id) {
    return "<eos>";
  }
  if (spec.padTokenId === id) {
    return "<pad>";
  }
  if (spec.unkTokenId === id) {
    return "<unk>";
  }
  return undefined;
}

function matchSpecialToken(
  text: string,
  cursor: number,
  spec: NativeTokenizerSpec,
): { content: string; id: number } | null {
  const specials = collectSpecialTokens(spec).sort((left, right) => right.content.length - left.content.length);
  for (const token of specials) {
    if (text.startsWith(token.content, cursor)) {
      return token;
    }
  }
  return null;
}

function isSpecialPiece(piece: string, spec: NativeTokenizerSpec): boolean {
  return collectSpecialTokens(spec).some((token) => token.content === piece)
    || (piece.startsWith("<") && piece.endsWith(">"));
}

function normalizePrependScheme(value: string): "always" | "first" | "never" {
  if (value === "first" || value === "never") {
    return value;
  }
  return "always";
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}
