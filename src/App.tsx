
import React from 'react';
import VideoStudio from './components/VideoStudio';
import ChatInterface from './components/ChatInterface';

const App: React.FC = () => {
  const proxyUrl = '';

  return (
    <div className="app">
      <header className="app-header">
        <h1>Lumenix-AI</h1>
        <p>Your Personal AI Assistant</p>
      </header>

      <main>
        <section>
          <ChatInterface />
        </section>

        <section>
          <VideoStudio proxyUrl={proxyUrl} />
        </section>
      </main>
    </div>
  );
};

export default App;
