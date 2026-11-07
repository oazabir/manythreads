import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Time } from '../../components/ui';
import { fetchOpens } from '../files/personalApi';

/**
 * Account → Security card: who opened your Personal space, when, and the reason they gave. Opening it is allowed to a workspace owner or admin, read-only
 * and for an hour, and it is always shown here.
 */
export function PersonalSpaceOpens() {
  const q = useQuery('account-personal-opens', () => fetchOpens({ limit: 30 }));
  return (
    <section className="block" aria-labelledby="acc-opens" data-landmark="personal-opens" data-testid="personal-opens">
      <h2 className="bh" id="acc-opens">Who opened your Personal space</h2>
      <QueryView q={q}>
        {({ items }) =>
          items.length === 0 ? (
            <div className="block-body">
              <p className="d" data-testid="personal-opens-none">No one has opened your Personal space. If a workspace admin ever needs to, it shows up here with their reason.</p>
            </div>
          ) : (
            <ul className="rows">
              {items.map((o) => (
                <li key={o.id} className="srow" data-testid="personal-open" data-active={o.active || undefined}>
                  <div>
                    <div>
                      {o.adminName}
                      {o.active ? ' (open now)' : ''}
                    </div>
                    <div className="d" data-vt-mask>{o.reason}</div>
                    <div className="d">Opened <Time iso={o.openedAt} /></div>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </section>
  );
}
