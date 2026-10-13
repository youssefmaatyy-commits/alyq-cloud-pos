export function ApplicationConfigurationScreen({ code }: { code: string }) {
  return <main role="alert" data-testid="production-configuration-error" className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
    <section className="max-w-lg rounded-xl border border-red-200 bg-white p-8 text-center">
      <h1 className="text-xl font-bold text-slate-900">Production configuration error</h1>
      <p className="mt-3 text-slate-700">This deployment is unavailable. Contact the deployment administrator. No local store or demo data has been loaded.</p>
      <p dir="rtl" className="mt-3 text-slate-700">إعدادات التشغيل غير صالحة. يُرجى التواصل مع مسؤول النشر. لم يتم تحميل متجر محلي أو بيانات تجريبية.</p>
      <p className="mt-4 text-sm text-slate-500">Diagnostic code: {code}</p>
    </section>
  </main>;
}
