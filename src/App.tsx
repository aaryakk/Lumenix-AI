
import React from 'react';
import ChatInterface from './components/ChatInterface';
import VideoStudio from './components/VideoStudio';

const App: React.FC = () => {
  return (
    <div className="app">
      <header className="app-header">
        <h1>LUMENIX AI</h1>
        <p>Your Personal AI Assistant</p>
      </header>

      <main>
        <ChatInterface />
        <VideoStudio proxyUrl="" />
      </main>
    </div>
  );
};

export default App;
