-- A workspace always keeps at least one owner (#375). Without one it can never be administered again: nobody can
-- manage owners or make a new one. better-auth's leave, remove-member and role-change endpoints each count the
-- owners and then write, with nothing between the two, so two owners leaving at once could both succeed. This rule
-- lives in the database, so it covers those endpoints and any path added later.
--
-- "Is an owner" is the same test the application uses (hasWorkspaceRole in packages/database/src/membership-roles.ts):
-- the stored role is a comma-separated list, and one of its trimmed entries is exactly 'owner'. A test checks the two
-- definitions against each other.
CREATE FUNCTION logbird_is_owner(role text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(string_to_array(coalesce(role, ''), ',')) AS entry WHERE btrim(entry) = 'owner')
$$;

-- BEFORE an owner row is deleted or stops being an owner: serialise changes to that organization's owners, before this
-- row changes. Two transactions removing the last two owners then run their checks one after the other; neither can
-- hold a row the other is waiting for, so they cannot deadlock on each other here.
CREATE FUNCTION logbird_lock_organization_owners() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF logbird_is_owner(OLD.role) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('logbird.organization-owners:' || OLD."organizationId", 0));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- AFTER the change, holding the lock: does the organization still have an owner?
-- * READ COMMITTED (the default, and what Prisma and better-auth use): this statement takes a fresh snapshot, so it sees
--   an owner removal another transaction committed while this one waited for the lock.
-- * SERIALIZABLE: the snapshot predates the wait, but Postgres's serializable checks see that each transaction read an
--   owner row the other removed, and abort one of them with 40001 (could not serialize); the caller retries.
-- * REPEATABLE READ: the snapshot predates the wait and nothing would catch a stale count, so removing or demoting an
--   owner is refused at that level (LB410). Logbird never uses it; a caller that does gets a clear error, never an
--   ownerless workspace.
-- The count takes no row locks: Postgres locks a row before its BEFORE trigger runs, so a transaction waiting for the
-- organization lock already holds its own owner row, and locking that row here would deadlock.
-- Deleting the organization itself (its members go by cascade, in the same statement) is allowed: the row is gone.
CREATE FUNCTION logbird_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  organization_id text := OLD."organizationId";
  owners integer;
BEGIN
  IF NOT logbird_is_owner(OLD.role) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND logbird_is_owner(NEW.role) AND NEW."organizationId" = OLD."organizationId" THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM organization WHERE id = organization_id) THEN RETURN NULL; END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'logbird_workspace_owner_isolation: owner changes need READ COMMITTED or SERIALIZABLE'
      USING ERRCODE = 'LB410';
  END IF;
  SELECT count(*) INTO owners FROM member WHERE "organizationId" = organization_id AND logbird_is_owner(role);
  IF owners = 0 THEN
    RAISE EXCEPTION 'logbird_workspace_needs_owner: a workspace needs at least one owner'
      USING ERRCODE = 'LB409', HINT = 'Make another member an owner first.';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER member_lock_organization_owners
  BEFORE DELETE OR UPDATE OF role, "organizationId" ON member
  FOR EACH ROW EXECUTE FUNCTION logbird_lock_organization_owners();

CREATE TRIGGER member_keep_an_owner
  AFTER DELETE OR UPDATE OF role, "organizationId" ON member
  FOR EACH ROW EXECUTE FUNCTION logbird_keep_an_owner();
