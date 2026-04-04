-- Change DescriptionMapping.categoryId foreign key from RESTRICT to CASCADE
-- so deleting a Category automatically cleans up its DescriptionMapping rows.

ALTER TABLE "DescriptionMapping" DROP CONSTRAINT "DescriptionMapping_categoryId_fkey";
ALTER TABLE "DescriptionMapping" ADD CONSTRAINT "DescriptionMapping_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
