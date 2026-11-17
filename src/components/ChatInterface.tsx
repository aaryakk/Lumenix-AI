
import React, { useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  status: string;
  answer: string;
}

const API_URL =
  'https://specifications-circular-according-charms.trycloudflare.com';

const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sendMessage = async () => {
    const message = input.trim();

    if (!message || loading) return;

    setInput('');
    setError('');

    setMessages(prev => [
      ...prev,
      { role: 'user', content: message }
    ]);

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message,
          language: 'hi'
        })
      });

      if (!response.ok) {
        throw new Error(`Server Error: ${response.status}`);
      }

      const data: ChatResponse = await response.json();

      if (!data.answer) {
        throw new Error('AI response not received');
      }

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: data.answer }
      ]);

    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-container">
      <h2>✨ LUMENIX AI Chat</h2>

      <div className="chat-messages">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`chat-message ${msg.role}`}
          >
            <strong>
              {msg.role === 'user' ? 'You' : 'Lumenix AI'}
            </strong>
            <p>{msg.content}</p>
          </div>
        ))}

        {loading && (
          <p className="chat-loading">
            Lumenix AI is thinking...
          </p>
        )}
      </div>

      {error && (
        <p className="chat-error">{error}</p>
      )}

      <div className="chat-input-area">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') sendMessage();
          }}
          placeholder="Ask Lumenix AI anything..."
          disabled={loading}
        />

        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
        >
          {loading ? 'Wait...' : 'Send'}
        </button>
      </div>
    </div>
  );
};

export default ChatInterface;
