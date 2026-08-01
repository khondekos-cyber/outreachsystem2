export default function SettingsPage() {
  return (
    <div className="p-10">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-slate-800 italic uppercase">Settings</h1>
        <p className="text-slate-400 font-medium">Configure your AI Sales Agent and WhatsApp Connection.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4 uppercase text-sm tracking-widest">WhatsApp Webhook</h3>
          <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-slate-400 text-sm font-mono">
            {/* Connection Status will go here */}
            Status: Disconnected
          </div>
          <button className="mt-6 w-full bg-indigo-600 text-white font-bold py-3 rounded-xl">Refresh Connection</button>
        </div>

        <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4 uppercase text-sm tracking-widest">Global AI Prompt</h3>
          <textarea 
            className="w-full p-4 bg-slate-50 border rounded-xl h-32 text-sm outline-none" 
            placeholder="System instructions for your sales agent..."
          />
          <button className="mt-4 w-full bg-slate-900 text-white font-bold py-3 rounded-xl">Save Changes</button>
        </div>
      </div>
    </div>
  );
}