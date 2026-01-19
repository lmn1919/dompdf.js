export function isEmptyValue(obj: any): Boolean {
  if (obj === undefined) {
    return true
  } else if (obj === null) {
    return true
  } else if (obj === false) {
    return true
  } else if (obj === '') {
    return true
  } else if (isArray(obj) && obj.length === 0) {
    return true
  } else if (isObject(obj) && JSON.stringify(obj) === '{}') {
    return true
  } else {
    return false
  }
}

export function isArray(obj: any): Boolean {
  return Object.prototype.toString.call(obj) === '[object Array]'
}

export function isObject(obj: any): Boolean {
  return Object.prototype.toString.call(obj) === '[object Object]'
}