-- A User's own display name (CRONK-39), shown in place of their email or GitHub login where Cronk names them.
-- Null when they set none; sign-in keeps using the email and GitHub account.
alter table users add column display_name text;
