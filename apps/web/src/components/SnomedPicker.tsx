import { useMemo, useState } from 'react';
import { Select } from '@mantine/core';
import { search, findBySnomed, type TermEntry } from '../lib/terminology.js';

/**
 * Coded diagnosis picker: SNOMED CT concept with its ICD-10 pairing.
 * Backed by lib/terminology.ts's STARTER subset (~100 concepts), not a
 * terminology server. Known gap, stated plainly: if the diagnosis isn't
 * in the starter list it cannot be coded here — the clinician writes it
 * in the Assessment free text instead (we never invent a code).
 */
export function SnomedPicker({
  onPick,
  label = 'Add diagnosis (SNOMED CT)',
  placeholder = 'Search e.g. hypertension, asthma, J45, 38341003…',
  excludeCodes = [],
}: {
  onPick: (term: TermEntry) => void;
  label?: string;
  placeholder?: string;
  excludeCodes?: string[];
}) {
  const [query, setQuery] = useState('');
  const data = useMemo(
    () =>
      search(query)
        .filter((t) => !excludeCodes.includes(t.snomed))
        .map((t) => ({ value: t.snomed, label: `${t.display} — SNOMED ${t.snomed} · ICD-10 ${t.icd10}` })),
    [query, excludeCodes]
  );

  return (
    <Select
      label={label}
      placeholder={placeholder}
      searchable
      clearable
      value={null}
      searchValue={query}
      onSearchChange={setQuery}
      data={data}
      // Results are already filtered/ranked by terminology.search().
      filter={({ options }) => options}
      nothingFoundMessage={query.trim() ? 'Not in starter terminology — describe it in Assessment free text' : undefined}
      onChange={(code) => {
        const term = code ? findBySnomed(code) : undefined;
        if (term) {
          onPick(term);
          setQuery('');
        }
      }}
    />
  );
}
