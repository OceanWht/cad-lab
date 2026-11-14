/**
 * 经纬度 → Web 墨卡托（EPSG:3857）投影。
 *
 * 子工程只保留大门模块使用的 `toMercator`，其余投影 / 路径工具不搬。
 */

/** 墨卡托投影允许的最大纬度 */
const MAX_LAT = 85.051128779806604

export function toMercator(lng: number, lat: number): [number, number] {
  const x = (lng * 20037508.34) / 180
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const y = Math.log(Math.tan(((90 + clampedLat) * Math.PI) / 360)) / (Math.PI / 180)
  return [x, (y * 20037508.34) / 180]
}
