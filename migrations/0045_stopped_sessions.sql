-- When the Transcript hook last uploaded a running Run's transcript on `Stop`, the end of its session's turn, with no
-- call naming the Run since: any later call clears it. A subscription Run still stopped this way after a short grace
-- period fails, its session having ended its turn without calling `finish`.
alter table runs add column stopped_at timestamptz;
