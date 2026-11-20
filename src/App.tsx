
import React from 'react';
import ChatInterface from './components/ChatInterface';
import VideoStudio from './components/VideoStudio';

const VIDEO_BACKEND_URL = (
  import.meta.env.VITE_LUMENIX_PROXY_URL || ''
).trim().replace(/\/$/, '');

const App: React.FC = () => {
  return (
    <div className="app">
      <header className="app-header">
        <h1>LUMENIX AI</h1>
        <p>Your Personal AI Assistant</p>
      </header>

      <main>
        <ChatInterface />
        <VideoStudio proxyUrl={VIDEO_BACKEND_URL} />
      </main>
    </div>
  );
};

export default App;
