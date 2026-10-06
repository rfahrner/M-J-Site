// Enough of a real day to fill the screen and then some: the board has to be
// taller than the viewport or a scroll jump has nowhere to show itself.
export function boardFixture({ shifts = 30, drivers = 40, location = 'atlanta', date } = {}) {
  const shiftDate = date || new Date().toISOString().slice(0, 10);
  return {
    loads_shifts: Array.from({ length: shifts }, (_, i) => ({
      id: 1000 + i,
      location,
      shift_date: shiftDate,
      driver_id: i % 3 === 0 ? null : 500 + (i % drivers),
      driver_name_text: i % 3 === 0 ? '' : `Driver ${String(i % drivers).padStart(2, '0')}`,
      pro_number: `PRO${9000 + i}`,
      shift_start: `${String(4 + (i % 16)).padStart(2, '0')}:00`,
      carrier_rate: 700 + i,
    })),
    loads_trips: [],
    trip_stops: [],
    atlanta_drivers: Array.from({ length: drivers }, (_, i) => ({
      id: 500 + i,
      'Driver Name': `Driver ${String(i).padStart(2, '0')}`,
      'Driver Cell': `770-555-${String(1000 + i).slice(-4)}`,
      'Dispatcher phone number': i % 3 === 0 ? '' : `770-555-${String(2000 + i).slice(-4)}`,
      'Driver Rating': ['A', 'B', 'C', 'A1', 'B2'][i % 5],
      'E mail': `driver${i}@example.com`,
      MC: 100000 + i,
      location,
      do_not_text: false,
    })),
    location_notes: [],
    board_rate_tiers: [],
    loads_accounting: [],
  };
}
