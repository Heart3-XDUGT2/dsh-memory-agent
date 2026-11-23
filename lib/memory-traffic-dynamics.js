import { initialHalfLife, reinforceHalfLife, retrievability } from './dmae.js'

export const TRAFFIC_REFERENCE = Object.freeze({
  intrinsicValue: 10, weight: 1, boost: 0.5, masterBoost: 1, maxWeight: 10,
  recallBonus: 0.4, decay: 0.5, source: 'reference-default/v1'
})
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0
const clock = value => Number.isSafeInteger(value) && value >= 0
export const validTrafficCount = row => row && Number.isSafeInteger(row.use_count)
  && row.use_count > 0 && clock(row.last_used_ms)
export function validTrafficModel(state, model) {
  return validTrafficCount(state) && positive(state.half_life_hours)
    && model?.intrinsic_value === TRAFFIC_REFERENCE.intrinsicValue && Number.isFinite(model.weight) && model.weight >= 0
    && model.weight <= TRAFFIC_REFERENCE.maxWeight && clock(model.model_started_ms)
    && model.model_started_ms <= state.last_used_ms && model.initialization === TRAFFIC_REFERENCE.source
}
/** LTP changes weight only; identity is a trusted caller parameter, never message metadata. */
export function trafficLtp(weight, isMaster = true) {
  if (!Number.isFinite(weight) || weight < 0 || weight > 10 || typeof isMaster !== 'boolean') throw Error('invalid_traffic_state')
  return Math.min(TRAFFIC_REFERENCE.maxWeight, weight + (isMaster ? TRAFFIC_REFERENCE.masterBoost : TRAFFIC_REFERENCE.boost))
}
export function trafficR(state, model, nowMs) {
  if (!clock(nowMs) || !validTrafficModel(state, model)) return null
  return retrievability(Math.max(0, nowMs - state.last_used_ms) / 3600000, state.half_life_hours)
}
export function recallTraffic(state, model, nowMs, isMaster = true) {
  if (!clock(nowMs) || (state && !validTrafficCount(state))
    || (state && !Number.isSafeInteger(state.use_count + 1))
    || (model && !validTrafficModel(state, model))
    || (!model && state?.half_life_hours != null)) throw Error('invalid_traffic_state')
  const h = model ? state.half_life_hours : initialHalfLife(TRAFFIC_REFERENCE.intrinsicValue)
  const r = model ? trafficR(state, model, nowMs) : 1
  const halfLifeHours = reinforceHalfLife(h, r)
  if (!positive(halfLifeHours)) throw Error('invalid_traffic_state')
  const nextModel = model || { intrinsic_value: TRAFFIC_REFERENCE.intrinsicValue,
    weight: TRAFFIC_REFERENCE.weight, model_started_ms: nowMs, initialization: TRAFFIC_REFERENCE.source }
  return { halfLifeHours, rBefore: r,
    model: { ...nextModel, weight: trafficLtp(nextModel.weight, isMaster) } }
}
/** Diagnostic only: no thresholds, filtering, or extra node/path strength. */
export function trafficPathUtility(linkIds, byId) {
  if (!linkIds.length) return { status: 'not_applicable', utility: null }
  const links = linkIds.map(id => byId.get(id))
  if (links.some(link => link?.status !== 'modeled' || !Number.isFinite(link.r) || link.r < 0 || link.r > 1
    || !Number.isFinite(link.weight) || link.weight < 0 || link.weight > 10)) return { status: 'unavailable', utility: null }
  return { status: 'ok', utility: links.reduce((value, link) =>
    value * (0.5 + link.weight / 10 + TRAFFIC_REFERENCE.recallBonus * link.r) * TRAFFIC_REFERENCE.decay, 1) }
}
