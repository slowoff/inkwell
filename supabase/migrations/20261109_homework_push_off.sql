-- 1.93.1 (Rafael: "remove the notification thing from homework"): stop the every-minute job that sent homework
-- reminders. Tables push_conf / push_subs / hw_sent, push_due() / push_pending() and the edge function `push` are
-- left in place (nothing deleted without asking); the daily inkwell-cron-cleanup job keeps the cron run log short.
select cron.unschedule('inkwell-homework-push')
where exists (select 1 from cron.job where jobname = 'inkwell-homework-push');
