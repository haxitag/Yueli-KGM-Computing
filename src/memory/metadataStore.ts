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
  /** 按主键删除一条；不存在则返回 false */
  deleteById(id: string): Promise<boolean>;
};
