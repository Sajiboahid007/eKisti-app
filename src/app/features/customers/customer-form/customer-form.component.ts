import { Component, inject, OnInit, signal, computed, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { MemberService } from '../../../core/services/member.service';
import { CashService } from '../../../core/services/cash.service';
import { SettingsService } from '../../../core/services/settings.service';
import { isValidBdNid, isValidBdMobile } from '../../../core/finance/validation';
import { Customer, Branch, CenterOrSamity, CustomerNominee, DocumentVersion } from '../../../core/models/database.models';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

type FlowMessage = { type: 'success' | 'danger' | 'warning' | 'info'; text: string };
type KycDocType = DocumentVersion['docType'];
type KycField = 'photoUrl' | 'nidFrontPhotoUrl' | 'nidBackPhotoUrl' | 'signaturePhotoUrl';

@Component({
  selector: 'app-customer-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './customer-form.component.html',
  styleUrl: './customer-form.component.scss'
})
export class CustomerFormComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  private memberService = inject(MemberService);
  private cashService = inject(CashService);
  private settingsService = inject(SettingsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staffList = this.authService.availableUsers;

  isEditMode = signal<boolean>(false);
  customerId = signal<number | null>(null);
  loading = signal<boolean>(false);
  submitting = signal<boolean>(false);

  // Mandatory reason when in edit mode
  updateReason: string = '';

  // ইনলাইন বার্তা (alert() এর পরিবর্তে)
  readonly messages = signal<FlowMessage[]>([]);
  // ফিল্ড-ভিত্তিক যাচাই ত্রুটি
  readonly errors = signal<Record<string, string>>({});
  // একই NID দিয়ে অন্য সদস্য থাকলে সতর্কতা
  readonly duplicateNidWarning = signal<string>('');
  readonly checkingNid = signal<boolean>(false);
  // নতুন সদস্য তৈরি সম্পন্ন হলে ফলাফল প্যানেল দেখাতে
  readonly createdCustomerId = signal<number | null>(null);

  // ভর্তি ফি ও পাসবুক ফি (শুধু নতুন সদস্য)
  admissionFee: number = 0;
  passbookFee: number = 0;

  // KYC ডকুমেন্ট (এডিট মোডে)
  readonly kycDocTypes: { type: KycDocType; label: string; field: KycField }[] = [
    { type: 'PHOTO', label: 'সদস্যের ছবি', field: 'photoUrl' },
    { type: 'NID_FRONT', label: 'NID (সামনের অংশ)', field: 'nidFrontPhotoUrl' },
    { type: 'NID_BACK', label: 'NID (পেছনের অংশ)', field: 'nidBackPhotoUrl' },
    { type: 'SIGNATURE', label: 'স্বাক্ষর', field: 'signaturePhotoUrl' }
  ];
  readonly kycUrls = signal<Partial<Record<KycDocType, string>>>({});
  readonly kycUploading = signal<KycDocType | null>(null);
  readonly docVersions = signal<DocumentVersion[]>([]);

  @Input() set customerToEdit(cust: Customer | null) {
    if (cust) {
      this.patchCustomerData(cust);
    } else if (!this.customerId()) {
      this.resetForm();
    }
  }

  @Output() formSubmitted = new EventEmitter<Customer>();
  @Output() formCancelled = new EventEmitter<void>();

  // Form Model
  customer: any = this.getDefaultCustomer();

  readonly selectedBranchId = signal<number>(1);

  readonly availableCenters = computed(() => {
    const bId = Number(this.selectedBranchId());
    return this.centers().filter(c => c.branchId === bId);
  });

  getDefaultCustomer(): any {
    return {
      branchId: 1,
      centerId: 101,
      assignedFieldOfficerId: 502,
      fullName: '',
      fatherName: '',
      motherName: '',
      spouseName: '',
      dateOfBirth: '1995-01-01',
      gender: 'FEMALE' as 'MALE' | 'FEMALE' | 'OTHER',
      phonePrimary: '',
      phoneSecondary: '',
      nidNumber: '',
      birthCertificateNo: '',
      presentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: 'মিরপুর',
        district: 'ঢাকা',
        houseOwnership: 'RENTED' as 'OWN' | 'RENTED' | 'FAMILY'
      },
      permanentAddress: {
        villageOrStreet: '',
        postOffice: '',
        thanaOrUpazila: '',
        district: ''
      },
      occupation: 'মুদি ব্যবসা',
      businessName: '',
      monthlyIncome: 25000,
      primaryGuarantor: {
        name: '',
        relation: 'স্বামী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'চালক'
      },
      secondaryGuarantor: {
        name: '',
        relation: 'প্রতিবেশী',
        phone: '',
        nidNumber: '',
        address: '',
        occupation: 'ব্যবসায়ী'
      },
      collateral: {
        hasBankCheque: true,
        bankName: 'ইসলামী ব্যাংক বাংলাদেশ পিএলসি',
        bankBranch: 'মিরপুর শাখা',
        accountNumber: '',
        chequeNumber: '',
        hasStamp: true,
        stampNumber: '',
        otherMortgageDetails: ''
      },
      nominees: [this.blankNominee(100)] as CustomerNominee[],
      groupNo: null as number | null,
      isGroupLeader: false,
      totalSavingsBalance: 0,
      totalLoansTaken: 0,
      activeLoansCount: 0,
      creditScore: 'GOOD' as const
    };
  }

  blankNominee(share = 0): CustomerNominee {
    return { name: '', relation: '', nidNumber: '', phone: '', sharePercent: share };
  }

  async ngOnInit() {
    await Promise.all([this.loadOrganizationData(), this.loadFeeDefaults()]);
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      const parsedId = Number(idParam);
      this.isEditMode.set(true);
      this.customerId.set(parsedId);
      await this.loadCustomerForEdit(parsedId);
    }
  }

  async loadOrganizationData() {
    try {
      const [bList, cList] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.branches.set(bList);
      this.centers.set(cList);

      if (bList.length > 0 && !this.isEditMode()) {
        const initialBranchId = bList[0].branchId;
        this.selectedBranchId.set(initialBranchId);
        this.customer.branchId = initialBranchId;

        const routesInBranch = cList.filter(c => c.branchId === initialBranchId);
        if (routesInBranch.length > 0) {
          this.customer.centerId = routesInBranch[0].centerId;
          this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
        }
      }
    } catch (e) {
      console.error('Error loading branch/center data:', e);
    }
  }

  /** সাধারণ সেটিংস থেকে ভর্তি ফি ও পাসবুক ফি এর ডিফল্ট মান */
  async loadFeeDefaults() {
    try {
      const general = await this.settingsService.getGeneralSettings();
      this.admissionFee = Number(general.defaultAdmissionFee) || 0;
      this.passbookFee = Number(general.defaultPassbookFee) || 0;
    } catch (e) {
      console.error('Error loading fee defaults:', e);
    }
  }

  resetForm() {
    this.messages.set([]);
    this.errors.set({});
    this.duplicateNidWarning.set('');
    this.createdCustomerId.set(null);
    this.kycUrls.set({});
    this.docVersions.set([]);
    this.isEditMode.set(false);
    this.customerId.set(null);
    this.updateReason = '';
    this.customer = this.getDefaultCustomer();
    if (this.branches().length > 0) {
      const bId = this.branches()[0].branchId;
      this.selectedBranchId.set(bId);
      this.customer.branchId = bId;
      const routesInBranch = this.centers().filter(c => c.branchId === bId);
      if (routesInBranch.length > 0) {
        this.customer.centerId = routesInBranch[0].centerId;
        this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
      }
    }
  }

  patchCustomerData(cust: Customer) {
    this.isEditMode.set(true);
    this.customerId.set(cust.customerId);
    this.updateReason = '';
    this.errors.set({});
    this.duplicateNidWarning.set('');
    const bId = Number(cust.branchId || 1);
    this.selectedBranchId.set(bId);

    this.customer = {
      customerId: cust.customerId,
      customerCode: cust.customerCode || `CUST-${cust.customerId}`,
      branchId: bId,
      centerId: Number(cust.centerId || 101),
      assignedFieldOfficerId: Number(cust.assignedFieldOfficerId || 502),
      fullName: cust.fullName || '',
      fatherName: cust.fatherName || '',
      motherName: cust.motherName || '',
      spouseName: cust.spouseName || '',
      dateOfBirth: cust.dateOfBirth ? cust.dateOfBirth.substring(0, 10) : '1995-01-01',
      gender: cust.gender || 'FEMALE',
      phonePrimary: cust.phonePrimary || '',
      phoneSecondary: cust.phoneSecondary || '',
      nidNumber: cust.nidNumber || '',
      birthCertificateNo: cust.birthCertificateNo || '',
      presentAddress: {
        villageOrStreet: cust.presentAddress?.villageOrStreet || '',
        postOffice: cust.presentAddress?.postOffice || '',
        thanaOrUpazila: cust.presentAddress?.thanaOrUpazila || '',
        district: cust.presentAddress?.district || 'ঢাকা',
        houseOwnership: cust.presentAddress?.houseOwnership || 'OWN'
      },
      permanentAddress: {
        villageOrStreet: cust.permanentAddress?.villageOrStreet || '',
        postOffice: cust.permanentAddress?.postOffice || '',
        thanaOrUpazila: cust.permanentAddress?.thanaOrUpazila || '',
        district: cust.permanentAddress?.district || ''
      },
      occupation: cust.occupation || '',
      businessName: cust.businessName || '',
      monthlyIncome: cust.monthlyIncome || 0,
      primaryGuarantor: {
        name: cust.primaryGuarantor?.name || '',
        relation: cust.primaryGuarantor?.relation || '',
        phone: cust.primaryGuarantor?.phone || '',
        nidNumber: cust.primaryGuarantor?.nidNumber || '',
        address: cust.primaryGuarantor?.address || '',
        occupation: cust.primaryGuarantor?.occupation || ''
      },
      secondaryGuarantor: {
        name: cust.secondaryGuarantor?.name || '',
        relation: cust.secondaryGuarantor?.relation || '',
        phone: cust.secondaryGuarantor?.phone || '',
        nidNumber: cust.secondaryGuarantor?.nidNumber || '',
        address: cust.secondaryGuarantor?.address || '',
        occupation: cust.secondaryGuarantor?.occupation || ''
      },
      collateral: {
        hasBankCheque: cust.collateral?.hasBankCheque ?? true,
        bankName: cust.collateral?.bankName || '',
        bankBranch: cust.collateral?.bankBranch || '',
        accountNumber: cust.collateral?.accountNumber || '',
        chequeNumber: cust.collateral?.chequeNumber || '',
        hasStamp: cust.collateral?.hasStamp ?? true,
        stampNumber: cust.collateral?.stampNumber || '',
        otherMortgageDetails: cust.collateral?.otherMortgageDetails || ''
      },
      nominees: (cust.nominees || []).map(n => ({
        name: n.name || '',
        relation: n.relation || '',
        nidNumber: n.nidNumber || '',
        phone: n.phone || '',
        sharePercent: Number(n.sharePercent) || 0
      })),
      groupNo: cust.groupNo ?? null,
      isGroupLeader: !!cust.isGroupLeader,
      admissionFeePaid: cust.admissionFeePaid || 0,
      passbookFeePaid: cust.passbookFeePaid || 0,
      totalSavingsBalance: cust.totalSavingsBalance || 0,
      totalLoansTaken: cust.totalLoansTaken || 0,
      activeLoansCount: cust.activeLoansCount || 0,
      creditScore: cust.creditScore || 'GOOD',
      status: cust.status || 'ACTIVE'
    };

    this.kycUrls.set({
      PHOTO: cust.photoUrl || '',
      NID_FRONT: cust.nidFrontPhotoUrl || '',
      NID_BACK: cust.nidBackPhotoUrl || '',
      SIGNATURE: cust.signaturePhotoUrl || ''
    });
    this.loadDocumentVersions(cust.customerId);
  }

  onBranchChange(branchId: any) {
    const bId = Number(branchId);
    this.selectedBranchId.set(bId);
    this.customer.branchId = bId;

    const routesInBranch = this.centers().filter(c => c.branchId === bId);
    if (routesInBranch.length > 0) {
      if (!routesInBranch.some(c => c.centerId === this.customer.centerId)) {
        this.customer.centerId = routesInBranch[0].centerId;
        this.customer.assignedFieldOfficerId = routesInBranch[0].fieldOfficerUserId;
      }
    } else {
      this.customer.centerId = null;
    }
  }

  onCenterChange(centerId: any) {
    const cid = Number(centerId);
    this.customer.centerId = cid;
    const center = this.centers().find(c => c.centerId === cid);
    if (center) {
      this.customer.assignedFieldOfficerId = center.fieldOfficerUserId;
    }
  }

  async loadCustomerForEdit(id: number) {
    this.loading.set(true);
    try {
      // 1. First search in kistiService getCustomers (handles cache and seeding)
      const allCustomers = await this.kistiService.getCustomers();
      let match = allCustomers.find(c => c.customerId === id);

      // 2. If not found in list, try direct getDoc from Firestore
      if (!match) {
        const docRef = doc(this.firestore, 'customers', id.toString());
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          match = snap.data() as Customer;
        }
      }

      if (match) {
        this.patchCustomerData(match);
      } else {
        this.showMessage('danger', 'গ্রাহক আইডি #' + id + ' পাওয়া যায়নি');
      }
    } catch (err) {
      console.error('Error loading customer:', err);
      // Fallback: try kistiService.getCustomers again
      try {
        const allCustomers = await this.kistiService.getCustomers();
        const match = allCustomers.find(c => c.customerId === id);
        if (match) {
          this.patchCustomerData(match);
        } else {
          this.showMessage('danger', 'গ্রাহকের তথ্য লোড করা যায়নি: ' + this.errorText(err, 'অজানা সমস্যা'));
        }
      } catch (e) {
        console.error('Fallback error:', e);
        this.showMessage('danger', 'গ্রাহকের তথ্য লোড করা যায়নি: ' + this.errorText(e, 'অজানা সমস্যা'));
      }
    } finally {
      this.loading.set(false);
    }
  }

  // ==========================================
  // ইনলাইন বার্তা
  // ==========================================
  showMessage(type: FlowMessage['type'], text: string, append = false) {
    this.messages.update(list => append ? [...list, { type, text }] : [{ type, text }]);
  }

  dismissMessage(index: number) {
    this.messages.update(list => list.filter((_, i) => i !== index));
  }

  private errorText(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  private get actor() {
    const u = this.authService.currentUser();
    return { userId: u.userId, name: u.name, role: u.role };
  }

  // ==========================================
  // নমিনি (Nominee)
  // ==========================================
  addNominee() {
    const list: CustomerNominee[] = this.customer.nominees || [];
    const remaining = Math.max(0, 100 - this.nomineeShareTotal());
    this.customer.nominees = [...list, this.blankNominee(remaining)];
  }

  removeNominee(index: number) {
    this.customer.nominees = (this.customer.nominees || []).filter((_: CustomerNominee, i: number) => i !== index);
  }

  nomineeShareTotal(): number {
    const total = (this.customer.nominees || []).reduce(
      (sum: number, n: CustomerNominee) => sum + (Number(n.sharePercent) || 0), 0);
    return Math.round(total * 100) / 100;
  }

  // ==========================================
  // যাচাই (Validation)
  // ==========================================
  fieldError(key: string): string {
    return this.errors()[key] || '';
  }

  validate(): Record<string, string> {
    const c = this.customer;
    const e: Record<string, string> = {};

    if (!c.fullName?.trim()) e['fullName'] = 'গ্রাহকের নাম লিখুন';
    if (!c.phonePrimary?.trim()) e['phonePrimary'] = 'প্রাথমিক মোবাইল নম্বর দিন';
    else if (!isValidBdMobile(c.phonePrimary)) e['phonePrimary'] = 'সঠিক মোবাইল নম্বর দিন (01[3-9]XXXXXXXX, ১১ ডিজিট)';
    if (c.phoneSecondary?.trim() && !isValidBdMobile(c.phoneSecondary)) e['phoneSecondary'] = 'বিকল্প মোবাইল নম্বর সঠিক নয়';
    if (!c.nidNumber?.trim()) e['nidNumber'] = 'জাতীয় পরিচয়পত্র নম্বর (NID) দিন';
    else if (!isValidBdNid(c.nidNumber)) e['nidNumber'] = 'NID অবশ্যই ১০, ১৩ বা ১৭ ডিজিটের হতে হবে';

    const g = c.primaryGuarantor || {};
    if (g.phone?.trim() && !isValidBdMobile(g.phone)) e['gPhone'] = 'জামিনদারের মোবাইল নম্বর সঠিক নয় (01[3-9]XXXXXXXX)';
    if (g.nidNumber?.trim() && !isValidBdNid(g.nidNumber)) e['gNid'] = 'জামিনদারের NID ১০, ১৩ বা ১৭ ডিজিটের হতে হবে';

    const groupNo = c.groupNo;
    if (groupNo !== null && groupNo !== undefined && groupNo !== '' && !(Number.isInteger(Number(groupNo)) && Number(groupNo) > 0)) {
      e['groupNo'] = 'দল নং একটি ধনাত্মক পূর্ণসংখ্যা হতে হবে';
    }

    const nominees: CustomerNominee[] = c.nominees || [];
    nominees.forEach((n, i) => {
      if (!n.name?.trim()) e[`nominee_${i}_name`] = 'নমিনির নাম লিখুন';
      if (!n.relation?.trim()) e[`nominee_${i}_relation`] = 'সম্পর্ক লিখুন';
      if (n.nidNumber?.trim() && !isValidBdNid(n.nidNumber)) e[`nominee_${i}_nid`] = 'NID সঠিক নয়';
      if (n.phone?.trim() && !isValidBdMobile(n.phone)) e[`nominee_${i}_phone`] = 'মোবাইল সঠিক নয়';
      if (!(Number(n.sharePercent) > 0)) e[`nominee_${i}_share`] = 'অংশ (%) দিন';
    });
    if (!this.isEditMode() && nominees.length === 0) {
      e['nominees'] = 'নতুন সদস্যের জন্য অন্তত একজন নমিনি আবশ্যক';
    } else if (nominees.length > 0 && Math.abs(this.nomineeShareTotal() - 100) > 0.01) {
      e['nominees'] = `নমিনিদের মোট অংশ ১০০% হতে হবে (বর্তমানে ${this.nomineeShareTotal()}%)`;
    }

    if (!this.isEditMode()) {
      if ((Number(this.admissionFee) || 0) < 0 || (Number(this.passbookFee) || 0) < 0) e['fees'] = 'ফি ঋণাত্মক হতে পারে না';
      if ((Number(c.totalSavingsBalance) || 0) < 0) e['openingSavings'] = 'প্রারম্ভিক সঞ্চয় ঋণাত্মক হতে পারে না';
    }

    if (this.isEditMode() && !this.updateReason.trim()) {
      e['updateReason'] = 'সংশোধন নিশ্চিত করতে পরিবর্তনের কারণ উল্লেখ করুন';
    }
    return e;
  }

  /** NID ঘর থেকে বের হলে ফরম্যাট ও ডুপ্লিকেট সদস্য যাচাই */
  async onNidBlur() {
    const nid = (this.customer.nidNumber || '').trim();
    this.duplicateNidWarning.set('');
    if (!nid) return;
    if (!isValidBdNid(nid)) {
      this.errors.update(e => ({ ...e, nidNumber: 'NID অবশ্যই ১০, ১৩ বা ১৭ ডিজিটের হতে হবে' }));
      return;
    }
    this.errors.update(e => {
      const next = { ...e };
      delete next['nidNumber'];
      return next;
    });
    this.checkingNid.set(true);
    try {
      const matches = await this.memberService.findByNid(nid, this.customerId() ?? undefined);
      if (matches.length > 0) {
        this.duplicateNidWarning.set(
          `এই NID দিয়ে ইতোমধ্যে সদস্য নিবন্ধিত আছে: ${matches.map(m => `${m.fullName} (#${m.customerId})`).join(', ')}`
        );
      }
    } catch (err) {
      console.error('NID duplicate check failed:', err);
    } finally {
      this.checkingNid.set(false);
    }
  }

  // ==========================================
  // সংরক্ষণ (Submit)
  // ==========================================
  private buildPayload(): any {
    const c = this.customer;
    const payload: any = {
      ...c,
      groupNo: c.groupNo === null || c.groupNo === undefined || c.groupNo === '' ? null : Number(c.groupNo),
      isGroupLeader: !!c.isGroupLeader,
      nominees: (c.nominees || []).map((n: CustomerNominee) => ({
        name: (n.name || '').trim(),
        relation: (n.relation || '').trim(),
        nidNumber: (n.nidNumber || '').trim(),
        phone: (n.phone || '').trim(),
        sharePercent: Number(n.sharePercent) || 0
      }))
    };
    // ফি সার্ভিসের মাধ্যমে জমা হয় — ফর্ম থেকে সরাসরি লেখা হয় না
    delete payload.admissionFeePaid;
    delete payload.passbookFeePaid;
    if (this.isEditMode()) {
      // সঞ্চয় স্থিতি ও ঋণ কাউন্টার খতিয়ান-নিয়ন্ত্রিত — এডিটে পাঠানো হয় না
      delete payload.totalSavingsBalance;
      delete payload.totalLoansTaken;
      delete payload.activeLoansCount;
    } else {
      payload.totalSavingsBalance = Number(c.totalSavingsBalance) || 0;
    }
    return payload;
  }

  async onSubmit() {
    const errs = this.validate();
    this.errors.set(errs);
    if (Object.keys(errs).length > 0) {
      this.showMessage('danger', 'ফরমে কিছু তথ্য সঠিক নয় — লাল চিহ্নিত ঘরগুলো সংশোধন করুন');
      return;
    }

    this.submitting.set(true);
    this.messages.set([]);
    const actor = this.actor;

    try {
      if (this.isEditMode()) {
        await this.kistiService.updateCustomer(this.customerId()!, this.buildPayload(), actor, this.updateReason);
        this.showMessage('success', `গ্রাহক #${this.customerId()} এর তথ্য সফলভাবে আপডেট ও হিস্ট্রি সংরক্ষণ করা হয়েছে`);
        this.updateReason = '';
        this.formSubmitted.emit(this.customer);
      } else {
        const newCust = await this.kistiService.createCustomer(this.buildPayload(), actor, 'নতুন সদস্য হিসেবে অন্তর্ভুক্ত');
        this.createdCustomerId.set(newCust.customerId);
        this.showMessage('success', `সফল! নতুন গ্রাহক আইডি #${newCust.customerId} (${newCust.fullName}) তৈরি হয়েছে`);

        const admission = Number(this.admissionFee) || 0;
        const passbook = Number(this.passbookFee) || 0;
        if (admission > 0 || passbook > 0) {
          try {
            await this.cashService.postMemberFees(newCust.customerId, { admission, passbook }, actor);
            this.showMessage('success', `ভর্তি ফি ৳${admission} ও পাসবুক ফি ৳${passbook} শাখার ভল্টে জমা হয়েছে`, true);
          } catch (feeErr) {
            console.error('Fee posting error:', feeErr);
            this.showMessage('warning',
              `সদস্য তৈরি হয়েছে, কিন্তু ভর্তি/পাসবুক ফি জমা করা যায়নি: ${this.errorText(feeErr, 'অজানা সমস্যা')}। পরে ফি আলাদাভাবে জমা করুন।`, true);
          }
        }
        this.formSubmitted.emit(newCust);
      }
    } catch (err) {
      console.error('Save error:', err);
      this.showMessage('danger', 'সংরক্ষণে সমস্যা হয়েছে: ' + this.errorText(err, 'অজানা সমস্যা'));
    } finally {
      this.submitting.set(false);
    }
  }

  registerAnother() {
    this.resetForm();
    this.loadFeeDefaults();
  }

  // ==========================================
  // KYC ডকুমেন্ট আপলোড (এডিট মোড)
  // ==========================================
  async loadDocumentVersions(customerId: number) {
    try {
      this.docVersions.set(await this.memberService.getDocumentVersions(customerId));
    } catch (err) {
      console.error('Error loading document versions:', err);
      this.docVersions.set([]);
    }
  }

  versionsFor(type: KycDocType): DocumentVersion[] {
    return this.docVersions().filter(v => v.docType === type);
  }

  isPdf(url: string | undefined): boolean {
    return !!url && /\.pdf$/i.test(url.split('?')[0]);
  }

  async onKycFileSelected(type: KycDocType, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const id = this.customerId();
    if (!file || !id) return;
    this.kycUploading.set(type);
    try {
      const url = await this.memberService.uploadKycDocument(id, type, file, this.actor);
      this.kycUrls.update(m => ({ ...m, [type]: url }));
      await this.loadDocumentVersions(id);
      const label = this.kycDocTypes.find(d => d.type === type)?.label || type;
      this.showMessage('success', `${label} সফলভাবে আপলোড হয়েছে (পুরাতন সংস্করণ সংরক্ষিত থাকবে)`);
    } catch (err) {
      console.error('KYC upload error:', err);
      this.showMessage('danger', 'ডকুমেন্ট আপলোডে সমস্যা: ' + this.errorText(err, 'অজানা সমস্যা'));
    } finally {
      this.kycUploading.set(null);
      input.value = '';
    }
  }

  cancel() {
    this.resetForm();
    this.formCancelled.emit();
    this.router.navigate(['/customers']);
  }
}
