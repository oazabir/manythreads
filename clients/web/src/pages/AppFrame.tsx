/** Empty app frame (PLAN Phase 1 §2): left rail, centre column, hidden right panel. */
export function AppFrame() {
  return (
    <div className="frame" data-testid="app-frame">
      <aside className="rail">
        <div className="region team-switch" data-landmark="team-switch" />
        <div className="region search" data-landmark="search" />
        <nav className="region sidebar" data-landmark="sidebar" />
      </aside>
      <main className="center">
        <header className="region header" data-landmark="header" />
        <section className="region content" data-landmark="content" />
      </main>
      <aside className="region right-panel" data-landmark="right-panel" hidden />
    </div>
  );
}
