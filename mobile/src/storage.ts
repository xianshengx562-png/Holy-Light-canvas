/**
 * 站点的地址 / 令牌 / 上次选的模型 —— 第一版就这三样，别的都不存（规格 A4：不做历史记录）。
 *
 * 🔴 令牌是明文存在 App 私有区（`Preferences` → Android 的 SharedPreferences）里的。
 * 这跟桌面端「加密入库」不一样：手机上没有本地后端，也没法安全地藏一把密钥
 * （藏了等于明文）。所以**别在这里再存别的东西**，尤其是别顺手把提示词历史记下来。
 */
import { Preferences } from '@capacitor/preferences';

/** 徐先那条中转站。设置页默认填这个。 */
export const DEFAULT_BASE_URL = 'https://www.myvigna.top';

const KEY_BASE_URL = 'site.baseUrl';
const KEY_API_KEY = 'site.apiKey';
const KEY_MODEL = 'gen.model';
const KEY_MODELS = 'gen.modelList';

export type Settings = { baseUrl: string; apiKey: string };

export async function loadSettings(): Promise<Settings> {
  const [baseUrl, apiKey] = await Promise.all([
    Preferences.get({ key: KEY_BASE_URL }),
    Preferences.get({ key: KEY_API_KEY }),
  ]);
  return {
    baseUrl: baseUrl.value || DEFAULT_BASE_URL,
    apiKey: apiKey.value || '',
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  await Preferences.set({
    key: KEY_BASE_URL,
    value: (next.baseUrl || '').trim() || DEFAULT_BASE_URL,
  });
  await Preferences.set({ key: KEY_API_KEY, value: (next.apiKey || '').trim() });
}

/** 上次选的模型。换站点 / 换令牌时调用方自己清掉。 */
export async function loadLastModel(): Promise<string> {
  const { value } = await Preferences.get({ key: KEY_MODEL });
  return value || '';
}

export async function saveLastModel(model: string): Promise<void> {
  await Preferences.set({ key: KEY_MODEL, value: model });
}

/**
 * 站点账号（登录后的 JWT）。**不存密码** —— 手机上没有安全的密钥托管（`Keychain`/`Keystore`
 * 也没接），明文落盘密码风险太大；JWT 过期了就让用户输入密码重新登一次。
 */
export type SiteAccount = { username: string; jwt: string; expiresAt: number };

const KEY_USERNAME = 'site.username';
const KEY_JWT = 'site.jwt';
const KEY_JWT_EXP = 'site.jwtExp';

export async function loadAccount(): Promise<SiteAccount | null> {
  const [username, jwt, exp] = await Promise.all([
    Preferences.get({ key: KEY_USERNAME }),
    Preferences.get({ key: KEY_JWT }),
    Preferences.get({ key: KEY_JWT_EXP }),
  ]);
  if (!jwt.value || !username.value) return null;
  return { username: username.value, jwt: jwt.value, expiresAt: Number(exp.value || 0) || 0 };
}

export async function saveAccount(account: SiteAccount): Promise<void> {
  await Preferences.set({ key: KEY_USERNAME, value: account.username });
  await Preferences.set({ key: KEY_JWT, value: account.jwt });
  await Preferences.set({ key: KEY_JWT_EXP, value: String(account.expiresAt) });
}

/** 退出登录：JWT 清掉。**保留** apiKey —— 手动粘的令牌可能还在用。 */
export async function clearAccount(): Promise<void> {
  await Promise.all([
    Preferences.remove({ key: KEY_USERNAME }),
    Preferences.remove({ key: KEY_JWT }),
    Preferences.remove({ key: KEY_JWT_EXP }),
  ]);
}

/** 模型清单缓存：没网的时候下拉里还有上一回的东西，不至于整个空掉。 */
export async function loadCachedModels(): Promise<string[]> {
  const { value } = await Preferences.get({ key: KEY_MODELS });
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveCachedModels(models: string[]): Promise<void> {
  await Preferences.set({ key: KEY_MODELS, value: JSON.stringify(models) });
}
