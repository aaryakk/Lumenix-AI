
import React, { useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  status?: string;
  answer?: string;
}

const API_URL = (
  import.meta.env.VITE_LUMENIX_CHAT_API_URL || ''
).trim().replace(/\/$/, '');

const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sendMessage = async () => {
    const message = input.trim();

    if (!message || loading) return;

    if (!API_URL) {
      setError('Chat backend is not configured yet.');
      return;
    }

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
        throw new Error('AI response not received.');
      }

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: data.answer! }
      ]);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="w-full mb-6 rounded-2xl border border-indigo-400/20 bg-slate-950/80 p-4 shadow-xl shadow-black/20">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl">
          ✨
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">
            LUMENIX AI Chat
          </h2>
          <p className="text-xs text-slate-400">
            Your intelligent AI assistant
          </p>
        </div>
      </div>

      <div className="mb-4 flex min-h-24 max-h-80 flex-col gap-3 overflow-y-auto rounded-xl bg-slate-900/70 p-3">
        {messages.length === 0 && (
          <div className="m-auto py-5 text-center">
            <div className="mb-2 text-3xl">✦</div>
            <p className="text-sm text-slate-300">
              Hello! How can I help you today?
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Ask me anything...
            </p>
          </div>
        )}

        {messages.map((msg, index) => (
          <div
            key={index}
            className={`max-w-[90%] rounded-xl p-3 text-sm ${
              msg.role === 'user'
                ? 'ml-auto bg-indigo-600 text-white'
                : 'mr-auto border border-slate-700 bg-slate-800 text-slate-100'
            }`}
          >
            <p className="mb-1 text-xs font-semibold opacity-70">
              {msg.role === 'user' ? 'You' : 'Lumenix AI'}
            </p>
            <p className="whitespace-pre-wrap break-words">
              {msg.content}
            </p>
          </div>
        ))}

        {loading && (
          <p className="text-sm text-indigo-300">
            Lumenix AI is thinking...
          </p>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') sendMessage();
          }}
          placeholder="Ask Lumenix AI anything..."
          disabled={loading}
          className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-indigo-500"
        />

        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          className="rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-5 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Wait...' : 'Send'}
        </button>
      </div>
    </section>
  );
};

export default ChatInterface;
