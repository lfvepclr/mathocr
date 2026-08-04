/**
 * App — Root component: hash routing, global SSE, view switching.
 *
 * M1 scope: upload home page (sidebar + upload + queue + settings).
 * Batch detail view renders a placeholder until M2 (Viewer) lands.
 */
import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useQueueStore } from '@/stores/queueStore';
import { Sidebar } from '@/components/Sidebar/Sidebar';
import { TopBar } from '@/components/TopBar/TopBar';
import { UploadZone } from '@/components/Upload/UploadZone';
import { QueuePanel } from '@/components/Queue/QueuePanel';
import { SettingsModal } from '@/components/Settings/SettingsModal';
import { Viewer } from '@/components/Viewer/Viewer';

export default function App() {
  const route = useAppStore((s) => s.route);
  const handleRoute = useAppStore((s) => s.handleRoute);
  const showSettings = useAppStore((s) => s.showSettings);
  const initQueue = useQueueStore((s) => s.init);

  // Hash routing
  useEffect(() => {
    handleRoute();
    window.addEventListener('hashchange', handleRoute);
    return () => window.removeEventListener('hashchange', handleRoute);
  }, [handleRoute]);

  // Global SSE for queue/sidebar progress
  useEffect(() => initQueue(), [initQueue]);

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <TopBar />
        {route === 'upload' ? (
          <div id="upload-view" className="upload-view active">
            {/* upload-container centers the hero + engine picker + drop zone */}
            <div className="upload-container">
              <UploadZone />
              <QueuePanel />
            </div>
          </div>
        ) : (
          <div id="results-view" className="results-view active">
            <Viewer />
          </div>
        )}
      </main>
      {showSettings && <SettingsModal />}
    </div>
  );
}
