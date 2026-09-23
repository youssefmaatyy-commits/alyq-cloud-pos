import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Rendered instead of the default screen. Use it where the audience is
   * different — a customer on the storefront, a cashier mid-sale — and the
   * wording should say so.
   */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * The last line of defence: a render error anywhere below this component shows
 * a screen instead of a blank page, and says what to do about it.
 *
 * What it does NOT show is the error. The message and the stack stay in the
 * console, where a developer can read them, because both are attacker-readable
 * here: a stack names the files and libraries in use, and a message can carry
 * whatever the failing call was holding — a Supabase URL, a query, a fragment of
 * a token. An earlier version of this screen printed `error.message` and
 * `error.stack` into a `<pre>` for anyone to read and copy.
 *
 * Both languages are on the screen at once rather than translated, because the
 * boundary has to work when the thing that broke is the i18n provider itself.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // The one place the detail is allowed to go. Nothing here is sent anywhere:
    // there is no error reporter in this project, and inventing one is not this
    // component's business.
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p dir="rtl" className="mt-1 text-base font-semibold text-slate-700">
              حدث خطأ غير متوقع
            </p>
            <p className="mt-4 text-sm leading-relaxed text-slate-600">
              This page stopped rendering. Nothing you entered was lost — reload to carry on.
            </p>
            <p dir="rtl" className="mt-2 text-sm leading-relaxed text-slate-500">
              توقّف عرض هذه الصفحة. لم يضيع ما أدخلته — أعد التحميل للمتابعة.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
            >
              Reload · إعادة التحميل
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
