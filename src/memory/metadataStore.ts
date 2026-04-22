export type MetadataRecord = {
  id: string;
  userId: string;
  text: string;
  source: string;
  createdAt: string;
};

export type MetadataStore = {
  upsert(record: MetadataRecord): Promise<void>;
  getMany(ids: string[]): Promise<MetadataRecord[]>;
};
