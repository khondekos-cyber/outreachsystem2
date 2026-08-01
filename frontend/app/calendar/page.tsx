"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import LeadModal from '@/components/dashboard/LeadModal';
import { CalendarClock, MapPin, RefreshCw } from 'lucide-react';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type Booking = {
  id: string;
  scheduled_at: string;
  status: string;
  leads: {
    id: string;
    name: string;
    industry: string;
    location: string;
    phone: string;
  } | null;
};

function groupByDay(bookings: Booking[]) {
  const groups: Record<string, Booking[]> = {};
  for (const b of bookings) {
    const dayKey = new Date(b.scheduled_at).toDateString();
    if (!groups[dayKey]) groups[dayKey] = [];
    groups[dayKey].push(b);
  }
  return Object.entries(groups).sort(
    ([a], [b]) => new Date(a).getTime() - new Date(b).getTime()
  );
}

export default function CalendarPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetchBookings();
    const sub = supabase
      .channel('calendar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => fetchBookings())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, []);

  const fetchBookings = async () => {
    setSyncing(true);
    const { data, error } = await supabase
      .from('bookings')
      .select('id, scheduled_at, status, leads(id, name, industry, location, phone)')
      .eq('status', 'confirmed')
      .gte('scheduled_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('scheduled_at', { ascending: true });
    if (error) console.error('❌ Failed to load bookings:', error);
    setBookings((data as any) || []);
    setSyncing(false);
  };

  const grouped = groupByDay(bookings);

  return (
    <div className="flex flex-col h-screen bg-[#f8fafc] overflow-hidden">
      <header className="px-6 py-4 flex justify-between items-center bg-white border-b">
        <div>
          <h1 className="text-xl font-black text-slate-800 italic uppercase tracking-tighter">Calendar</h1>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-[0.2em]">{bookings.length} DEMOS BOOKED</p>
        </div>
        <button onClick={fetchBookings} className={`p-2 rounded-full hover:bg-slate-50 border transition-all ${syncing ? 'animate-spin' : ''}`}>
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
        {grouped.length === 0 && (
          <p className="text-slate-400 text-sm font-bold">No demos booked yet.</p>
        )}

        {grouped.map(([day, dayBookings]) => (
          <div key={day}>
            <h3 className="font-black text-slate-400 text-[9px] uppercase tracking-[0.3em] mb-4 px-2">
              {new Date(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {dayBookings.map((b) => (
                <div
                  key={b.id}
                  onClick={() => b.leads && setSelected(b.leads)}
                  className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-lg hover:-translate-y-0.5 cursor-pointer transition-all active:scale-95"
                >
                  <div className="flex justify-between items-start mb-3">
                    <span className="text-[8px] bg-indigo-600 text-white px-2 py-0.5 rounded-full font-black uppercase tracking-widest">
                      {b.leads?.industry || 'TRADE'}
                    </span>
                    <div className="flex items-center gap-1 text-indigo-500 font-black text-[10px]">
                      <CalendarClock size={12} />
                      {new Date(b.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>

                  <h4 className="font-black text-slate-800 text-sm uppercase italic leading-none truncate">
                    {b.leads?.name || 'NEW LEAD'}
                  </h4>

                  <div className="mt-4 pt-3 border-t border-slate-50 flex items-center justify-between">
                    <div className="flex items-center text-slate-400 gap-1 font-black text-[8px] uppercase tracking-tighter">
                      <MapPin size={10} className="text-indigo-400" /> {b.leads?.location || 'GLOBAL'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected && <LeadModal lead={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

