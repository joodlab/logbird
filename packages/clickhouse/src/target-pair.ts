/**
 * ONE target has exactly this type and id (#169: same position, never the type on one target and the id on another).
 * The single definition behind both the `record:` query field and a read scope's target (#180), so they cannot drift.
 * `has(target_ids, …)` is implied by the match; it lets ClickHouse use the target_ids skip index first.
 * Values are always bound parameters; callers choose distinct parameter names.
 */
export function pairedTargetSql(typeParam: string, idParam: string) {
  return `has(target_ids, {${idParam}:String}) AND arrayExists((t, i) -> t = {${typeParam}:String} AND i = {${idParam}:String}, target_types, target_ids)`;
}
