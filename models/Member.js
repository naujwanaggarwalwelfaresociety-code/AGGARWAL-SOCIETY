const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  memberId: { type: String, required: true, unique: true, index: true },
  receiptNo: { type: String, required: true },
  fullName: { type: String, required: true, trim: true },
  firstName: { type: String, default: '' },
  middleName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  gotra: { type: String, default: '' },
  otherGotra: { type: String, default: '' },
  fatherHusbandName: { type: String, default: '' },
  sex: { type: String, default: 'Male' },
  dob: { type: String, default: '' },
  age: { type: String, default: '' },
  mobileNo: { type: String, required: true, index: true },
  whatsappNo: { type: String, default: '' },
  email: { type: String, default: '' },
  
  // Address
  houseNo: { type: String, default: '' },
  streetNo: { type: String, default: '' },
  roadName: { type: String, default: '' },
  landmark: { type: String, default: '' },
  constituency: { type: String, default: '' },
  pincode: { type: String, default: '' },
  address: { type: String, default: '' },

  // Family
  maritalStatus: { type: String, default: 'Unmarried' },
  spouseName: { type: String, default: '' },
  spouseDob: { type: String, default: '' },
  spouseAge: { type: String, default: '' },
  spouseProfession: { type: String, default: '' },
  hasChildren: { type: mongoose.Schema.Types.Mixed, default: 'No' },
  childCount: { type: String, default: '0' },
  childrenSummary: { type: String, default: '' },
  childrenList: { type: Array, default: [] },

  // Profession
  profession: { type: String, default: '' },
  professionDetail: { type: String, default: '' },
  professionBrief: { type: String, default: '' },
  combinedProfession: { type: String, default: '' },

  // Payment & Membership
  amountPaid: { type: Number, default: 1100 },
  paymentMethod: { type: String, default: 'UPI' },
  transactionRef: { type: String, default: '' },
  paymentStatus: { type: String, default: 'Completed', index: true },
  designation: { type: String, default: 'Executive Member' },
  joiningDate: { type: String, default: '' },
  validityUpto: { type: String, default: '' }
}, {
  timestamps: true,
  strict: false
});

memberSchema.index({ createdAt: -1 });
memberSchema.index({ fullName: 1 });
memberSchema.index({ constituency: 1 });

module.exports = mongoose.model('Member', memberSchema);
