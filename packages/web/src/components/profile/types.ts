import type { FieldSpec } from "../../profileSchema";
import type { PathSegment } from "../../profilePath";

/**
 * `SchemaField.tsx` ile `overrides.tsx` (ve onun altındaki widget'lar) arasında
 * gerçek bir döngüsel import vardı: `SchemaField` → `overrides` →
 * `RolesEditor` → `SchemaField` (recursive render için). ESM'de bazen çalışır
 * ama kırılgan — tip burada, `render` fonksiyonu ise prop olarak taşınır
 * (aşağıdaki `SchemaFieldProps.renderField`), böylece widget'lar `SchemaField`
 * modülüne hiç bağımlı olmaz.
 */
export interface SchemaFieldProps {
  spec: FieldSpec;
  value: unknown;
  path: PathSegment[];
  onChange: (path: PathSegment[], value: unknown) => void;
}
