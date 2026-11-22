import { CloudIcon, LifeBuoyIcon, ServerIcon } from 'lucide-react';
import type { Dimension, Plan } from '../../content/pricing';
import { cx } from '../../lib/cx';
import { ButtonLink } from './button-link';

const icons = { server: ServerIcon, cloud: CloudIcon, support: LifeBuoyIcon } as const;

/**
 * The plan cards on /pricing and /cloud, from content/pricing.ts. A figure renders only when the plan has one for a
 * dimension; while pricing isn't approved there are no dimensions and no figures, so cards show their status line.
 */
export function PlanCards({ plans, dimensions }: { plans: Plan[]; dimensions: Dimension[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-3">
      {plans.map((plan) => {
        const Icon = icons[plan.icon];
        const figures = dimensions.filter((dimension) => plan.figures[dimension.id]);
        return (
          <li className={cx('panel flex flex-col gap-5 p-6 md:p-7', plan.cta.primary && 'panel-accent')} key={plan.id}>
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-lg border bg-background text-brand">
                <Icon className="size-4" />
              </span>
              <h3 className="h3">{plan.name}</h3>
            </div>
            <p className="font-semibold text-2xl tracking-tight">{plan.status}</p>
            <p className="text-muted-foreground leading-relaxed">{plan.body}</p>
            {figures.length ? (
              <dl className="grid gap-2 text-sm">
                {figures.map((dimension) => (
                  <div className="flex justify-between gap-4 border-t pt-2" key={dimension.id}>
                    <dt className="text-muted-foreground">{dimension.label}</dt>
                    <dd className="font-medium">{plan.figures[dimension.id]?.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="mt-auto pt-2">
              {plan.cta.href ? (
                <ButtonLink className="w-full" href={plan.cta.href} variant={plan.cta.primary ? 'default' : 'outline'}>
                  {plan.cta.label}
                </ButtonLink>
              ) : (
                <ButtonLink className="w-full" search={plan.cta.search} to={plan.cta.to} variant={plan.cta.primary ? 'default' : 'outline'}>
                  {plan.cta.label}
                </ButtonLink>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
