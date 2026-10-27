import mongoose from 'mongoose'

const vehicleSchema = new mongoose.Schema({
  id:                { type: String, required: true },
  line_id:           String,
  route_id:          String,
  pattern_id:        String,
  trip_id:           String,
  stop_id:           String,
  lat:               Number,
  lon:               Number,
  bearing:           Number,
  current_status:    String,
  occupancy_status:  String,
  door_status:       String,
  timestamp:         Date,
  seen_at:           { type: Date, default: Date.now }
}, { collection: 'vehicles' })

vehicleSchema.index({ id: 1 }, { unique: true })
vehicleSchema.index({ line_id: 1 })
vehicleSchema.index({ seen_at: 1 }, { expireAfterSeconds: 3600 })

export const Vehicle = mongoose.model('Vehicle', vehicleSchema)
