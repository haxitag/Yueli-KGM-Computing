import type { ConversationMessage } from "../core/types.js";

export type StoredResponse = {
  id: string;
  requestId: string;
  model: string;
  conversation: ConversationMessage[];
  metadata?: Record<string, unknown>;
};

export class OpenAiResponseStore {
  private responses = new Map<string, StoredResponse>();

  save(record: StoredResponse): void {
    this.responses.set(record.id, record);
  }

  get(id: string): StoredResponse | undefined {
    return this.responses.get(id);
  }
}
