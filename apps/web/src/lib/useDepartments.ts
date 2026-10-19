import { useEffect, useState } from 'react';
import type { Organization } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { DEPT_SYSTEM } from './hospital.js';

/**
 * Loads the seeded department Organizations (scripts/seed/seed-departments.mjs)
 * keyed by DEPT_SYSTEM code. Returns undefined while loading.
 */
export function useDepartments(): Record<string, Organization> | undefined {
  const medplum = useMedplum();
  const [depts, setDepts] = useState<Record<string, Organization> | undefined>();
  useEffect(() => {
    medplum
      .searchResources('Organization', { identifier: `${DEPT_SYSTEM}|`, _count: 100 })
      .then((orgs) => {
        const map: Record<string, Organization> = {};
        for (const o of orgs) {
          const code = o.identifier?.find((i) => i.system === DEPT_SYSTEM)?.value;
          if (code) map[code] = o;
        }
        setDepts(map);
      })
      .catch(() => setDepts({}));
  }, [medplum]);
  return depts;
}

export function deptCodeOf(org: Organization | undefined): string | undefined {
  return org?.identifier?.find((i) => i.system === DEPT_SYSTEM)?.value;
}
