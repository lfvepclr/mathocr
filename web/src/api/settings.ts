/** Settings, engines, usage, and legend API. */
import { getJSON, postJSON } from './client';

export interface EngineInfo {
  id: string;
  name: string;
  billing: string;
  requires_key: boolean;
  configured: boolean;
  is_default: boolean;
  note: string;
  limitations: string[];
  price: { billing: string; unit: string; configured: boolean; [k: string]: any };
}

export interface SettingsView {
  global: Record<string, string>;
  siliconflow: Record<string, string>;
  baidu: Record<string, string>;
}

export interface UsageData {
  engines: { engine: string; name: string; calls: number; cost: number }[];
  // API returns "total" (singular), not "totals" — the old name crashed
  // the settings modal when accessing .calls on undefined.
  total: { calls: number; cost: number };
}

export const settingsApi = {
  engines: () => getJSON<{ engines: EngineInfo[]; default: string }>(`/api/engines`),
  getSettings: () => getJSON<SettingsView>(`/api/settings`),
  applySettings: (payload: Record<string, Record<string, string>>) =>
    postJSON<{ updated: string[]; settings: SettingsView; engines: EngineInfo[] }>(`/api/settings`, payload),
  usage: (scope: 'today' | 'month' | 'all' = 'all') =>
    getJSON<UsageData>(`/api/usage?scope=${scope}`),
  estimate: (engine: string, pages: number) =>
    getJSON<any>(`/api/usage/estimate?engine=${engine}&pages=${pages}`),
  legend: (mode: string = 'score') => getJSON<any>(`/api/legend?mode=${mode}`),
};
