export const fetchJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}`);
  return (await res.json()) as T;
};
