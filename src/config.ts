import {isAbsolute,relative,resolve,sep} from 'node:path';

// 1.2.14：同一台电脑运行两个账号时，每个实例用独立的端口和数据目录。
// 默认值保持旧行为（127.0.0.1:38321 + data/），账号1的启动方式和控制页都不变；
// 账号2由启动脚本设置 BADMINTON_PORT 与 BADMINTON_DATA_DIR 后启动。
export const DEFAULT_PORT = 38321;
export const DEFAULT_DATA_DIR = 'data';

export interface InstanceConfig {
  projectDir: string;
  dataDir: string;
  // 写入控制页/日志的短名称，例如 data 或 data-b（不含项目绝对路径）。
  dataDirName: string;
  port: number;
  url: string;
  open: boolean;
}

// 数据目录只允许项目内的 data / data-b / data2 之类，避免误把任务、登录资料写进源码目录。
const DATA_DIR_NAME = /^data(?:[-_.][A-Za-z0-9]+)*$/;

export function resolveConfig(projectDir: string, env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): InstanceConfig {
  const portText = (env.BADMINTON_PORT ?? '').trim() || String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portText)) throw Error(`端口配置无效（BADMINTON_PORT=${portText}），应为 1024–65535 的整数`);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error(`端口配置无效（BADMINTON_PORT=${portText}），应为 1024–65535 的整数`);
  const root = resolve(projectDir);
  const raw = (env.BADMINTON_DATA_DIR ?? '').trim() || DEFAULT_DATA_DIR;
  if (isAbsolute(raw)) throw Error(`数据目录必须是项目目录内的相对路径（BADMINTON_DATA_DIR=${raw}）`);
  const dataDir = resolve(root, raw);
  const rel = relative(root, dataDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error(`数据目录必须位于项目目录内（BADMINTON_DATA_DIR=${raw}）`);
  const dataDirName = rel.split(sep).join('/');
  if (!DATA_DIR_NAME.test(dataDirName)) throw Error(`数据目录名只能以 data 开头，例如 data 或 data-b（BADMINTON_DATA_DIR=${raw}）`);
  return {projectDir: root, dataDir, dataDirName, port, url: `http://127.0.0.1:${port}`, open: argv.includes('--open')};
}
