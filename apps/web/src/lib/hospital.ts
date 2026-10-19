/**
 * Shared hospital structure: departments and staff roles. Single source of
 * truth for every feature that scopes data or work queues by department.
 *
 * Departments are FHIR `Organization` resources (partOf the hospital),
 * identified by DEPT_SYSTEM|code — seeded by scripts/seed/seed-departments.mjs.
 * A staff member's department + role is a `PractitionerRole`
 * (organization = department, code = ROLE_SYSTEM|role). Server-side access
 * enforcement is Medplum AccessPolicy, one per role (see seed script).
 */
export const DEPT_SYSTEM = 'https://hins.example/fhir/department';
export const ROLE_SYSTEM = 'https://hins.example/fhir/staff-role';

export const DEPARTMENTS = [
  { code: 'emergency', name: 'Emergency' },
  { code: 'general-medicine', name: 'General Medicine (OPD)' },
  { code: 'cardiology', name: 'Cardiology' },
  { code: 'pediatrics', name: 'Pediatrics' },
  { code: 'inpatient-ward', name: 'Inpatient Wards' },
  { code: 'laboratory', name: 'Laboratory' },
  { code: 'radiology', name: 'Radiology' },
  { code: 'pharmacy', name: 'Pharmacy' },
  { code: 'nutrition', name: 'Nutrition & Dietetics' },
  { code: 'billing', name: 'Billing & Insurance' },
  { code: 'administration', name: 'Administration' },
] as const;
export type DepartmentCode = (typeof DEPARTMENTS)[number]['code'];

export const ROLES = [
  { code: 'physician', name: 'Physician' },
  { code: 'nurse', name: 'Nurse' },
  { code: 'triage-nurse', name: 'Triage Nurse' },
  { code: 'lab-technician', name: 'Lab Technician' },
  { code: 'pathologist', name: 'Pathologist' },
  { code: 'radiology-technician', name: 'Radiology Technician' },
  { code: 'radiologist', name: 'Radiologist' },
  { code: 'pharmacist', name: 'Pharmacist' },
  { code: 'dietitian', name: 'Dietitian' },
  { code: 'billing-staff', name: 'Billing Staff' },
  { code: 'front-desk', name: 'Front Desk' },
  { code: 'hospital-admin', name: 'Hospital Admin' },
] as const;
export type RoleCode = (typeof ROLES)[number]['code'];

export const deptName = (code: string): string => DEPARTMENTS.find((d) => d.code === code)?.name ?? code;
export const roleName = (code: string): string => ROLES.find((r) => r.code === code)?.name ?? code;
