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
  /** 可选：按用户列出近期记录（观测面板） */
  listRecent?(params?: { userId?: string; limit?: number; offset?: number }): Promise<MetadataRecord[]>;
  /** 可选：聚合统计 */
  getStats?(): Promise<{ totalChunks: number; userCount: number; byUser: Array<{ userId: string; chunks: number }> }>;
};
