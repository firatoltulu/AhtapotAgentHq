-- Proje başına en yeni 5 `superseded` profil sürümü kalır, eskileri silinir
-- (sınırın kaynağı: analyst.ts `SUPERSEDED_KEEP`). Onay artık aynı kuralı her
-- seferinde uyguluyor; bu dosya o kuraldan önce biriken fazlalığı temizler.
--
-- Bir işin hâlâ `profile_id` ile gösterdiği sürüm SİLİNMEZ: iş o profile
-- bakarak koşuyor/koştu (`DELETE /api/profiles/:id` ile aynı kural). Böyle bir
-- sürüm 5'lik kotada sayılır ama kotayı aşsa da yerinde kalır.
CREATE TEMP TABLE `doomed_profiles` AS
SELECT `id` FROM (
  SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `project_id` ORDER BY `version` DESC) AS `rn`
  FROM `project_profiles`
  WHERE `status` = 'superseded'
)
WHERE `rn` > 5
  AND `id` NOT IN (SELECT `profile_id` FROM `jobs` WHERE `profile_id` IS NOT NULL);
--> statement-breakpoint
DELETE FROM `profile_image_builds` WHERE `profile_id` IN (SELECT `id` FROM `doomed_profiles`);
--> statement-breakpoint
DELETE FROM `audit_log` WHERE `subject_id` IN (SELECT `id` FROM `doomed_profiles`);
--> statement-breakpoint
DELETE FROM `project_profiles` WHERE `id` IN (SELECT `id` FROM `doomed_profiles`);
--> statement-breakpoint
DROP TABLE `doomed_profiles`;
