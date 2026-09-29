import 'server-only';
import { db as client } from './engine';
import { engineKind, flushSync, setDataDir } from './store';

/**
 * 桌面版的数据入口。**上层 18 个文件 import 的就是这个 `db`**，写法与 Prisma 一致。
 *
 * 底下不再是 PostgreSQL：数据在**SQLite**（数据目录下的 `frame.db`，见 `store-sqlite.ts`），
 * 查询仍然由 `engine.ts` 在内存里完成。原来那句 `new PrismaClient()` 换成了这里的常量，
 * 其余调用点一个字没改。
 *
 * 主进程启动时要先 `setDataDir()`；退出前要 `flushData()`，否则最后 200ms 内的改动会丢。
 * 想确认现在到底落在哪个引擎上（排障第一件事）就问 `dbEngine()`。
 */
export const db = client;

export { setDataDir, flushSync as flushData, engineKind as dbEngine };
export type { Db } from './engine';
