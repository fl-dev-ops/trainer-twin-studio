-- The scenarios API is read-only, so existing keys created before the endpoint
-- existed get the "scenarios" read permission (defaultPermissions only apply
-- at key creation). Keys without assignment permissions never had org access
-- to role-play data, so they are left untouched.

UPDATE "apikey"
SET permissions = (
  jsonb_set(permissions::jsonb, '{scenarios}', '["read"]'::jsonb)
)::text
WHERE permissions IS NOT NULL
  AND permissions::jsonb ? 'assignments'
  AND NOT (permissions::jsonb ? 'scenarios');
