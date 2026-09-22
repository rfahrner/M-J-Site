-- Dispatchers get trip sheets and paperwork as PDFs as often as photographs,
-- but all three buckets allowed images only, so a PDF was rejected by Storage
-- before the browser's own filters ever mattered. This is purely additive --
-- every image type each bucket already took is preserved, with application/pdf
-- appended -- and the 15 MB per-file limit is untouched.
--
-- Applied to the live project; verified afterwards that all three buckets read
-- back with application/pdf appended and their image types intact.
update storage.buckets
   set allowed_mime_types = array_append(allowed_mime_types, 'application/pdf')
 where name in ('mondelez-routes', 'trip-sheets', 'paperwork-submissions')
   and not ('application/pdf' = any (allowed_mime_types));
