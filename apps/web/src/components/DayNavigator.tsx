import { addDays, format } from 'date-fns';
import { Button } from '@/ui/Button';
import { Input } from '@/ui/Input';
import { parseDateInputValue } from '@/lib/date';

interface Props {
  date: Date;
  onChange: (next: Date) => void;
}

/**
 * Compact prev / `<input type="date">` / next / today control. Used in
 * the app header to navigate the displayed day on the Timeline.
 */
export function DayNavigator({ date, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        onClick={() => onChange(addDays(date, -1))}
        className="!px-2 !py-1"
        aria-label="Previous day"
      >
        ←
      </Button>
      <Input
        type="date"
        value={format(date, 'yyyy-MM-dd')}
        onChange={(e) => {
          if (!e.target.value) return;
          onChange(parseDateInputValue(e.target.value));
        }}
        className="!w-auto !px-2 !py-1"
      />
      <Button
        variant="secondary"
        onClick={() => onChange(addDays(date, 1))}
        className="!px-2 !py-1"
        aria-label="Next day"
      >
        →
      </Button>
      <Button
        variant="secondary"
        onClick={() => onChange(new Date())}
        className="!px-2 !py-1"
      >
        Today
      </Button>
    </div>
  );
}
