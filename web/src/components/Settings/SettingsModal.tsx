/** SettingsModal — engine selection, API keys, usage/cost. */
import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { settingsApi, type EngineInfo, type SettingsView, type UsageData } from '@/api/settings';

export function SettingsModal() {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [form, setForm] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      settingsApi.engines(),
      settingsApi.getSettings(),
      settingsApi.usage('all'),
    ]).then(([engResp, settings, usage]) => {
      setEngines(engResp.engines);
      setSettings(settings);
      setUsage(usage);
      setForm(settings as unknown as Record<string, Record<string, string>>);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await settingsApi.applySettings(form);
      setEngines(result.engines);
      setSettings(result.settings);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (scope: string, field: string, value: string) => {
    setForm((prev) => ({ ...prev, [scope]: { ...prev[scope], [field]: value } }));
  };

  return (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">引擎与费用设置</span>
          <button className="btn-icon" onClick={() => setShowSettings(false)} title="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          {engines.map((e) => (
            <div key={e.id} className="engine-card">
              <div className="engine-card-header">
                <span className="engine-name">{e.name}</span>
                <span className={`engine-status ${e.configured ? 'ok' : 'warn'}`}>
                  {e.configured ? '已配置' : '未配置'}
                </span>
                {e.is_default && <span className="engine-default">默认</span>}
              </div>
              <p className="engine-note">{e.note}</p>
              {e.requires_key && settings && form[e.id] && (
                <div className="engine-fields">
                  {Object.entries(form[e.id]).map(([field, value]) => (
                    <label key={field} className="field-row">
                      <span className="field-label">{field}</span>
                      <input
                        type={field.includes('key') || field.includes('secret') ? 'password' : 'text'}
                        value={value}
                        onChange={(ev) => updateField(e.id, field, ev.target.value)}
                        placeholder={field.includes('key') || field.includes('secret') ? '留空保持不变' : ''}
                      />
                    </label>
                  ))}
                </div>
              )}
              {e.limitations.length > 0 && (
                <ul className="engine-limits">
                  {e.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
            </div>
          ))}
          {usage && (
            <div className="usage-summary">
              <h4>用量统计</h4>
              <table className="usage-table">
                <thead><tr><th>引擎</th><th>调用次数</th><th>费用</th></tr></thead>
                <tbody>
                  {usage.engines.map((row) => (
                    <tr key={row.engine}>
                      <td>{row.name}</td>
                      <td>{row.calls}</td>
                      <td>¥{row.cost.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td>合计</td><td>{usage.total.calls}</td><td>¥{usage.total.cost.toFixed(4)}</td></tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
