import mongoose from 'mongoose'

const lineSchema = new mongoose.Schema({
  id:                { type: String, required: true },
  short_name:        String,
  long_name:         String,
  color:             String,
  text_color:        String,
  route_ids:         [String],
  pattern_ids:       [String],
  municipality_ids:  [String],
  synced_at:         { type: Date, default: Date.now }
}, { collection: 'lines' })

lineSchema.index({ id: 1 }, { unique: true })

export const Line = mongoose.model('Line', lineSchema)
