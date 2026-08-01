/**
 * Layout helpers that need measurement.
 *
 * The search is separated from the DOM so it can be tested: it takes a
 * predicate rather than an element, and is guaranteed to terminate and to
 * return a size within the given bounds.
 */

/**
 * The largest size in [min, max] for which `fits` is true, stepping down by
 * `step`. Returns `min` when nothing fits, so the caller always gets a usable
 * value rather than zero or undefined.
 *
 * `fits` is assumed monotonic: if a size fits, every smaller size fits too.
 */
export function largestFittingSize(fits, { max = 15, min = 9, step = 0.5 } = {}) {
  if (!(max >= min) || !(step > 0)) return min;
  for (let size = max; size >= min; size -= step) {
    if (fits(size)) return size;
  }
  return min;
}
