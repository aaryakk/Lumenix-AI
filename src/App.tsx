
import React from 'react';
import VideoStudio from './components/VideoStudio';

const App: React.FC = () => {
  const proxyUrl = '';

  return (
    <div className="app">
      <header className="app-header">
        <h1>Lumenix-AI</h1>
        <p>AI Video Generation Studio</p>
      </header>

      <main>
        <VideoStudio proxyUrl={proxyUrl} />
      </main>
    </div>
  );
};

export default App;
