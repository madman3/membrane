import { MemoryWorkspace } from "../components/MemoryWorkspace";

export default function HomePage() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    return (
      <main className="app">
        <section className="status-card">
          <h1>Memory Evaluation</h1>
          <p>Set NEXT_PUBLIC_API_URL in .env before starting the web app.</p>
        </section>
      </main>
    );
  }

  return <MemoryWorkspace apiUrl={apiUrl} />;
}
