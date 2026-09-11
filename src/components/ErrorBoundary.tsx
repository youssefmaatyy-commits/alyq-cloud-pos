import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-red-50 p-8">
          <div className="mx-auto max-w-2xl rounded-lg bg-white p-6 shadow-lg">
            <h1 className="mb-4 text-2xl font-bold text-red-600">Application Error</h1>
            <p className="mb-4 text-slate-700">An error occurred while rendering this page:</p>
            <pre className="rounded bg-slate-100 p-4 text-sm text-red-800 overflow-auto max-h-96">
              {this.state.error?.message || "Unknown error"}
              {"\n\n"}
              {this.state.error?.stack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
