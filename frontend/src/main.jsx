import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import 'material-symbols/outlined.css'

class GlobalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorDetails: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, errorDetails: error.message }; }
  componentDidCatch(error, errorInfo) { console.error("Renderer Crash Intercepted:", error, errorInfo); }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-full bg-slate-950 text-slate-200 p-6 font-sans">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-3 text-rose-500">
              <span className="material-symbols-outlined text-3xl">warning</span>
              <h1 className="text-xl font-black uppercase tracking-wider">UI Render Fault</h1>
            </div>
            <p className="text-sm text-slate-400 font-medium">An interface error occurred. Data preserved.</p>
            <div className="bg-slate-950 border border-slate-800 p-3 rounded-lg overflow-x-auto">
              <code className="text-xs font-mono text-rose-400">{this.state.errorDetails || "Unknown Exception"}</code>
            </div>
            <button onClick={() => window.location.reload()} className="mt-4 w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black py-3 rounded-xl uppercase tracking-wider transition-colors">Restart Interface</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </React.StrictMode>,
)