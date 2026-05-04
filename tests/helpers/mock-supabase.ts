/**
 * Tiny chainable mock for @supabase/supabase-js used in V1 read tests.
 */

type Filter = [string, ...unknown[]];

interface PlanContext {
  table: string;
  filters: Filter[];
  count: boolean;
  head: boolean;
}

interface PlanResult {
  data: unknown;
  error: unknown;
  count?: number;
}

type Plan = (ctx: PlanContext) => PlanResult | Promise<PlanResult>;

interface RecordedCall {
  table: string;
  filters: Filter[];
  count: boolean;
}

export function createMockSupabase(tablePlans: Record<string, Plan>) {
  const calls: RecordedCall[] = [];

  function buildBuilder(table: string, plan: Plan) {
    let _count = false;
    let _head = false;
    const filters: Filter[] = [];

    const builder: any = {
      select(_fields?: string, options?: { count?: string; head?: boolean }) {
        if (options && options.count) _count = true;
        if (options && options.head) _head = true;
        return builder;
      },
      eq(col: string, value: unknown) {
        filters.push(['eq', col, value]);
        return builder;
      },
      ilike(col: string, value: unknown) {
        filters.push(['ilike', col, value]);
        return builder;
      },
      gte(col: string, value: unknown) {
        filters.push(['gte', col, value]);
        return builder;
      },
      is(col: string, value: unknown) {
        filters.push(['is', col, value]);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        filters.push(['limit', n]);
        return builder;
      },
      then(
        onFulfilled: (value: PlanResult) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        try {
          const result = plan({ table, filters, count: _count, head: _head });
          calls.push({ table, filters: [...filters], count: _count });
          return Promise.resolve(result).then(onFulfilled, onRejected);
        } catch (error) {
          if (onRejected) return Promise.resolve(onRejected(error));
          return Promise.reject(error);
        }
      },
    };
    return builder;
  }

  const supabase: any = {
    from(table: string) {
      const plan = tablePlans[table];
      if (!plan) {
        return buildBuilder(table, () => ({ data: [], error: null, count: 0 }));
      }
      return buildBuilder(table, plan);
    },
  };

  return { supabase, calls };
}

export function findFilter(filters: Filter[], op: string, col: string): Filter | undefined {
  return filters.find((f) => f[0] === op && f[1] === col);
}
