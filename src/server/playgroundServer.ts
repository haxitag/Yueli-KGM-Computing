import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { playgroundRouter } from './playgroundApi.js';
import { createExpressCorsOptions } from './corsPolicy.js';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createPlaygroundServer(port: number = 3001) {
  const app = express();

  // 中间件（禁止默认 cors(*)；开发默认仅本机 Origin）
  app.use(cors(createExpressCorsOptions()));
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 静态文件服务
  app.use('/', express.static(path.join(__dirname, '../../playground')));
  app.use('/generated-images', express.static(path.join(__dirname, '../../data/generated-images')));
  app.use('/generated-videos', express.static(path.join(__dirname, '../../data/generated-videos')));
  app.use('/generated-audio', express.static(path.join(__dirname, '../../data/generated-audio')));

  // API路由
  app.use('/api/kgm', playgroundRouter);

  // 根路径重定向到index.html
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../playground/index.html'));
  });

  // 启动服务器
  const server = app.listen(port, () => {
    console.log(`KGM-Computing Playground server running on http://localhost:${port}`);
    console.log(`Playground UI available at http://localhost:${port}`);
  });

  return server;
}

// 如果直接运行此文件，则启动服务器
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.env.PORT_PLAYGROUND || '3001');
  createPlaygroundServer(port);
}