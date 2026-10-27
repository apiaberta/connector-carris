import mongoose from 'mongoose'

const stopSchema = new mongoose.Schema({
  id:                 { type: String, required: true },
  name:               String,
  lat:                Number,
  lon:                Number,
  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number]
  },
  municipality_id:    String,
  municipality_name:  String,
  locality:           String,
  line_ids:           [String],
  synced_at:          { type: Date, default: Date.now }
}, { collection: 'stops' })

stopSchema.index({ id: 1 }, { unique: true })
stopSchema.index({ location: '2dsphere' })
stopSchema.index({ municipality_id: 1 })
stopSchema.index({ name: 'text' })

export const Stop = mongoose.model('Stop', stopSchema)
