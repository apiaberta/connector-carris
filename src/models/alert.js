import mongoose from 'mongoose'

const alertSchema = new mongoose.Schema({
  alert_id:        { type: String, required: true },
  cause:           String,
  effect:          String,
  header_pt:       String,
  header_en:       String,
  description_pt:  String,
  description_en:  String,
  url:             String,
  active_from:     Date,
  active_to:       Date,
  routes:          [String],
  stops:           [String],
  lines:           [String],
  active:          { type: Boolean, default: true },
  first_seen:      { type: Date, default: Date.now },
  last_seen:       { type: Date, default: Date.now }
}, { collection: 'alerts' })

alertSchema.index({ alert_id: 1 }, { unique: true })
alertSchema.index({ active: 1, active_to: -1 })
alertSchema.index({ routes: 1 })
alertSchema.index({ stops: 1 })
alertSchema.index({ last_seen: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 })

export const Alert = mongoose.model('Alert', alertSchema)
