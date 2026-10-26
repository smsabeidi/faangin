import type { SessionListFilter } from '../../shared/types'

function midnight(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose a valid calendar date.')
  const [year, month, day] = value.split('-').map(Number), date = new Date(`${value}T00:00:00`)
  if (year < 1970 || !Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error('Choose a valid date from 1970 onward.')
  return date
}
/** Local calendar days, with an exclusive next-midnight bound across DST changes. */
export function sessionDateFilter(from: string, through: string): SessionListFilter {
  const start = from ? midnight(from) : null, end = through ? midnight(through) : null
  if (end) end.setDate(end.getDate() + 1)
  if (start && end && start.getTime() >= end.getTime()) throw new Error('Choose an end date on or after the start date.')
  return { ...(start ? { updatedFrom: start.getTime() } : {}), ...(end ? { updatedBefore: end.getTime() } : {}) }
}
